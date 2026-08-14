import {
  IDE_PROTOCOL_VERSION,
  IDE_READ_ONLY_CAPABILITIES,
  type IdeCapability,
  type IdeClientHello,
  type IdeOpenSessionInstruction,
  parseIdeOpenSessionInstruction,
} from '@longleash/protocol'
import { isAbsolute, relative, sep } from 'node:path'
import { claudeNativeDispatchVerified } from './compatibility.js'

/** Current minimum established by Anthropic's VS Code documentation. */
export const MIN_VSCODE_VERSION = '1.94.0'
/** Conservative V0 floor: the exact build independently inspected in the first contract pass. */
export const MIN_TESTED_CLAUDE_EXTENSION_VERSION = '2.1.229'
/** Conservative V0 floor: the generated app-server schema used by this contract pass. */
export const MIN_TESTED_CODEX_VERSION = '0.147.0'

const UNTRUSTED_CAPABILITIES = new Set<IdeCapability>(['diagnostics.read'])
const READ_ONLY_CAPABILITIES = new Set<IdeCapability>(IDE_READ_ONLY_CAPABILITIES)

export interface CapabilityNegotiationInput {
  client: IdeClientHello
  serverProtocol: { min: number; max: number }
  serverCapabilities: readonly IdeCapability[]
  credential: 'active' | 'revoked'
  expectedExtensionBuild?: string
}

export type CapabilityNegotiation =
  | {
      accepted: false
      reason: 'credential-revoked' | 'protocol-incompatible'
      capabilities: []
      mutationMode: 'read-only'
    }
  | {
      accepted: true
      selectedProtocol: number
      reason?: 'workspace-untrusted' | 'build-mismatch'
      capabilities: IdeCapability[]
      mutationMode: 'enabled' | 'read-only'
    }

/**
 * Intersect, then reduce. Unknown power is never inferred from a matching build number, and an
 * untrusted workspace gets diagnostics only even when a credential was originally broader.
 */
export function negotiateCapabilities(input: CapabilityNegotiationInput): CapabilityNegotiation {
  if (input.credential === 'revoked') {
    return {
      accepted: false,
      reason: 'credential-revoked',
      capabilities: [],
      mutationMode: 'read-only',
    }
  }

  const lowestMaximum = Math.min(input.client.protocol.max, input.serverProtocol.max)
  const highestMinimum = Math.max(input.client.protocol.min, input.serverProtocol.min)
  if (highestMinimum > lowestMaximum) {
    return {
      accepted: false,
      reason: 'protocol-incompatible',
      capabilities: [],
      mutationMode: 'read-only',
    }
  }

  const offered = new Set(input.client.capabilities)
  let capabilities = input.serverCapabilities.filter((capability) => offered.has(capability))
  let reason: 'workspace-untrusted' | 'build-mismatch' | undefined

  if (!input.client.vscode.workspaceTrusted) {
    reason = 'workspace-untrusted'
    capabilities = capabilities.filter((capability) => UNTRUSTED_CAPABILITIES.has(capability))
  } else if (
    input.expectedExtensionBuild !== undefined &&
    input.expectedExtensionBuild !== input.client.extension.build
  ) {
    reason = 'build-mismatch'
    capabilities = capabilities.filter((capability) => READ_ONLY_CAPABILITIES.has(capability))
  }

  return {
    accepted: true,
    selectedProtocol: lowestMaximum,
    ...(reason === undefined ? {} : { reason }),
    capabilities,
    mutationMode: capabilities.some((capability) => !READ_ONLY_CAPABILITIES.has(capability))
      ? 'enabled'
      : 'read-only',
  }
}

export interface ProviderInstallation {
  installed: boolean
  version?: string
}

export type ClaudeOpenPlan =
  | { kind: 'blocked'; code: ClaudeBlockCode }
  | {
      kind: 'dispatch'
      uri: string
      /** The vendor handler accepted a request; it did not attest which chat rendered. */
      verification: 'preflight-only'
    }

export type ClaudeBlockCode =
  | 'expired'
  | 'workspace-untrusted'
  | 'window-not-focused'
  | 'editor-scheme-unsupported'
  | 'workspace-not-open'
  | 'workspace-mismatch'
  | 'remote-workspace-unsupported'
  | 'provider-missing'
  | 'provider-too-old'
  | 'provider-contract-unverified'
  | 'native-session-unverified'
  | 'ownership-not-reserved'
  | 'capability-denied'

export interface ClaudeOpenInput {
  instruction: IdeOpenSessionInstruction
  client: IdeClientHello
  grantedCapabilities: readonly IdeCapability[]
  provider: ProviderInstallation
  now: number
}

/**
 * Fail before touching the official URI. Anthropic documents that an unknown session falls back
 * to a fresh conversation, so dispatch is allowed only after the authenticated daemon has just
 * verified the native record and this exact VS Code window owns the corresponding workspace.
 */
export function planClaudeOpen(input: ClaudeOpenInput): ClaudeOpenPlan {
  const instruction = parseIdeOpenSessionInstruction(input.instruction)
  if (input.now > instruction.expiresAt) return { kind: 'blocked', code: 'expired' }
  if (!input.grantedCapabilities.includes('claude.dispatch')) {
    return { kind: 'blocked', code: 'capability-denied' }
  }
  if (!input.client.vscode.workspaceTrusted) {
    return { kind: 'blocked', code: 'workspace-untrusted' }
  }
  if (input.client.vscode.remoteAuthority !== null) {
    return { kind: 'blocked', code: 'remote-workspace-unsupported' }
  }
  if (!input.client.vscode.windowFocused) {
    return { kind: 'blocked', code: 'window-not-focused' }
  }
  if (input.client.vscode.uriScheme !== 'vscode') {
    return { kind: 'blocked', code: 'editor-scheme-unsupported' }
  }
  if (!input.provider.installed) return { kind: 'blocked', code: 'provider-missing' }
  if (
    input.provider.version === undefined ||
    compareVersions(input.provider.version, MIN_TESTED_CLAUDE_EXTENSION_VERSION) < 0
  ) {
    return { kind: 'blocked', code: 'provider-too-old' }
  }
  if (instruction.provider !== 'claude' || instruction.destination !== 'claude-native') {
    return { kind: 'blocked', code: 'native-session-unverified' }
  }
  if (instruction.ownership !== 'ide-reserved') {
    return { kind: 'blocked', code: 'ownership-not-reserved' }
  }
  if (
    instruction.nativeRecord.canonicalWorkspace !== instruction.canonicalWorkspace ||
    instruction.nativeRecord.verifiedAt > instruction.issuedAt ||
    instruction.issuedAt - instruction.nativeRecord.verifiedAt > 5_000
  ) {
    return { kind: 'blocked', code: 'native-session-unverified' }
  }

  const roots = input.client.vscode.workspaceFolders
    .map((folder) => folder.canonicalPath)
    .filter((path): path is string => path !== undefined)
  if (roots.length === 0) return { kind: 'blocked', code: 'workspace-not-open' }
  if (!roots.some((root) => containsCanonicalPath(root, instruction.canonicalWorkspace))) {
    return { kind: 'blocked', code: 'workspace-mismatch' }
  }
  if (!claudeNativeDispatchVerified(input.provider.version)) {
    return { kind: 'blocked', code: 'provider-contract-unverified' }
  }

  return {
    kind: 'dispatch',
    uri: buildClaudeSessionUri(instruction.nativeId),
    verification: 'preflight-only',
  }
}

export function buildClaudeSessionUri(nativeId: string): string {
  if (nativeId.trim() === '' || nativeId.length > 240 || /[\u0000-\u001f\u007f]/u.test(nativeId)) {
    throw new Error('Claude session id is not safe to place in a URI')
  }
  const uri = new URL('vscode://anthropic.claude-code/open')
  uri.searchParams.set('session', nativeId)
  return uri.toString()
}

export interface CodexThreadSnapshot {
  source: 'daemon-mirror'
  threadId: string
  status: 'notLoaded' | 'idle' | 'active' | 'systemError'
  /** Only the daemon talks to app-server. The editor is a view over this mirror. */
  appServerOwner: 'daemon'
}

export type CodexOpenPlan =
  | {
      kind: 'blocked'
      code:
        | 'expired'
        | 'workspace-untrusted'
        | 'remote-workspace-unsupported'
        | 'workspace-mismatch'
        | 'capability-denied'
        | 'thread-snapshot-missing'
        | 'thread-snapshot-mismatch'
    }
  | {
      kind: 'open-editor'
      verification: 'extension-owned'
      mode: 'read-only' | 'writable'
      threadId: string
    }

export function planCodexEditor(input: {
  instruction: IdeOpenSessionInstruction
  client: IdeClientHello
  grantedCapabilities: readonly IdeCapability[]
  snapshot?: CodexThreadSnapshot
  now: number
}): CodexOpenPlan {
  const instruction = parseIdeOpenSessionInstruction(input.instruction)
  if (input.now > instruction.expiresAt) return { kind: 'blocked', code: 'expired' }
  if (!input.grantedCapabilities.includes('codex.render')) {
    return { kind: 'blocked', code: 'capability-denied' }
  }
  if (!input.client.vscode.workspaceTrusted) {
    return { kind: 'blocked', code: 'workspace-untrusted' }
  }
  if (input.client.vscode.remoteAuthority !== null) {
    return { kind: 'blocked', code: 'remote-workspace-unsupported' }
  }
  const roots = input.client.vscode.workspaceFolders
    .map((folder) => folder.canonicalPath)
    .filter((path): path is string => path !== undefined)
  if (!roots.some((root) => containsCanonicalPath(root, instruction.canonicalWorkspace))) {
    return { kind: 'blocked', code: 'workspace-mismatch' }
  }
  if (input.snapshot === undefined) {
    return { kind: 'blocked', code: 'thread-snapshot-missing' }
  }
  if (
    instruction.provider !== 'codex' ||
    instruction.destination !== 'codex-longleash' ||
    input.snapshot.source !== 'daemon-mirror' ||
    input.snapshot.appServerOwner !== 'daemon' ||
    input.snapshot.threadId !== instruction.nativeId
  ) {
    return { kind: 'blocked', code: 'thread-snapshot-mismatch' }
  }

  return {
    kind: 'open-editor',
    verification: 'extension-owned',
    mode: instruction.ownership === 'ide-reserved' ? 'writable' : 'read-only',
    threadId: input.snapshot.threadId,
  }
}

function containsCanonicalPath(root: string, target: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(target)) return false
  const between = relative(root, target)
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
}

/** Numeric capability floors only; prerelease labels sort below the corresponding stable build. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { parts: number[]; prerelease: boolean } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim())
    if (match === null) return null
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: value.includes('-'),
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return -1
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (a.prerelease === b.prerelease) return 0
  return a.prerelease ? -1 : 1
}

export const V0_PROTOCOL_RANGE = { min: IDE_PROTOCOL_VERSION, max: IDE_PROTOCOL_VERSION } as const
