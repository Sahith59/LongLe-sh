import { describe, expect, it } from 'vitest'
import {
  IDE_PROTOCOL_VERSION,
  IdeClientHelloSchema,
  IdeOpenSessionInstructionSchema,
  IdeOpenSessionResultSchema,
  IdeSessionInventorySchema,
} from '../src/index.js'

const instruction = {
  v: IDE_PROTOCOL_VERSION,
  type: 'ide.openSession' as const,
  operationId: 'op_123',
  issuedAt: 1_000,
  expiresAt: 31_000,
  provider: 'claude' as const,
  sessionId: 'session_123',
  nativeId: 'native_123',
  canonicalWorkspace: '/Users/example/project',
  destination: 'claude-native' as const,
  nativeRecord: {
    verifiedAt: 900,
    canonicalWorkspace: '/Users/example/project',
  },
  ownership: 'ide-reserved' as const,
}

describe('VS Code companion protocol', () => {
  it('accepts a bounded, capability-negotiated client hello', () => {
    const parsed = IdeClientHelloSchema.parse({
      v: IDE_PROTOCOL_VERSION,
      type: 'ide.hello',
      clientInstanceId: 'window_123',
      protocol: { min: 1, max: 1 },
      extension: { version: '0.0.1', build: 'dev' },
      vscode: {
        version: '1.131.0',
        uriScheme: 'vscode',
        remoteAuthority: null,
        workspaceTrusted: true,
        windowFocused: true,
        workspaceFolders: [
          { uri: 'file:///Users/example/project', canonicalPath: '/Users/example/project' },
        ],
      },
      capabilities: ['diagnostics.read', 'sessions.read'],
    })

    expect(parsed.clientInstanceId).toBe('window_123')
  })

  it('rejects an invalid protocol range and unknown capabilities', () => {
    const base = {
      v: IDE_PROTOCOL_VERSION,
      type: 'ide.hello',
      clientInstanceId: 'window_123',
      extension: { version: '0.0.1', build: 'dev' },
      vscode: {
        version: '1.131.0',
        uriScheme: 'vscode',
        remoteAuthority: null,
        workspaceTrusted: true,
        windowFocused: true,
        workspaceFolders: [],
      },
    }

    expect(
      IdeClientHelloSchema.safeParse({
        ...base,
        protocol: { min: 2, max: 1 },
        capabilities: ['diagnostics.read'],
      }).success,
    ).toBe(false)
    expect(
      IdeClientHelloSchema.safeParse({
        ...base,
        protocol: { min: 1, max: 1 },
        capabilities: ['generic-shell'],
      }).success,
    ).toBe(false)
  })

  it('binds each provider to its honest destination', () => {
    expect(IdeOpenSessionInstructionSchema.parse(instruction).destination).toBe('claude-native')
    expect(
      IdeOpenSessionInstructionSchema.safeParse({
        ...instruction,
        destination: 'codex-longleash',
      }).success,
    ).toBe(false)

    expect(
      IdeOpenSessionInstructionSchema.safeParse({
        ...instruction,
        provider: 'codex',
        destination: 'claude-native',
      }).success,
    ).toBe(false)
  })

  it('rejects expired-at-issue operations', () => {
    expect(
      IdeOpenSessionInstructionSchema.safeParse({
        ...instruction,
        expiresAt: instruction.issuedAt,
      }).success,
    ).toBe(false)
    expect(
      IdeOpenSessionInstructionSchema.safeParse({
        ...instruction,
        expiresAt: instruction.issuedAt + 60_001,
      }).success,
    ).toBe(false)
  })

  it('never lets a Claude URI dispatch masquerade as a verified exact open', () => {
    const common = {
      v: IDE_PROTOCOL_VERSION,
      type: 'ide.openSessionResult',
      operationId: 'op_123',
      provider: 'claude',
      destination: 'claude-native',
      extensionBuild: 'dev',
      completedAt: 2_000,
    }

    expect(
      IdeOpenSessionResultSchema.safeParse({
        ...common,
        outcome: 'dispatched',
        verification: 'preflight-only',
      }).success,
    ).toBe(true)
    expect(
      IdeOpenSessionResultSchema.safeParse({
        ...common,
        outcome: 'opened',
        verification: 'extension-owned',
      }).success,
    ).toBe(false)
  })

  it('requires machine-readable failures and truthful verification states', () => {
    const common = {
      v: IDE_PROTOCOL_VERSION,
      type: 'ide.openSessionResult',
      operationId: 'op_123',
      provider: 'codex',
      destination: 'codex-longleash',
      extensionBuild: 'dev',
      completedAt: 2_000,
    }

    expect(
      IdeOpenSessionResultSchema.safeParse({
        ...common,
        outcome: 'blocked',
        verification: 'none',
      }).success,
    ).toBe(false)
    expect(
      IdeOpenSessionResultSchema.safeParse({
        ...common,
        outcome: 'blocked',
        verification: 'none',
        failure: 'workspace-untrusted',
      }).success,
    ).toBe(true)
    expect(
      IdeOpenSessionResultSchema.safeParse({
        ...common,
        outcome: 'opened',
        verification: 'extension-owned',
      }).success,
    ).toBe(true)
  })

  it('accepts a bounded, complete session inventory snapshot', () => {
    const snapshot = IdeSessionInventorySchema.parse({
      v: IDE_PROTOCOL_VERSION,
      type: 'ide.sessionInventory',
      streamId: 'daemon_boot_1',
      cursor: 42,
      generatedAt: 2_000,
      sessions: [
        {
          sessionId: 'session_123',
          provider: 'claude',
          title: 'Review the checkout safety contract',
          origin: 'phone',
          status: 'waiting',
          live: true,
          resumable: true,
          controller: 'longleash',
          attention: 'approval',
          workspace: { label: 'LongLeash', branch: 'main', mode: 'shared' },
          updatedAt: 1_999,
        },
      ],
    })

    expect(snapshot.sessions[0]?.attention).toBe('approval')
  })

  it('rejects duplicate sessions and impossible attention states', () => {
    const session = {
      sessionId: 'session_123',
      provider: 'codex',
      title: 'Inspect the protocol',
      origin: 'vscode',
      status: 'ended',
      live: false,
      resumable: true,
      attention: 'question',
      workspace: { label: 'LongLeash', mode: 'shared' },
      updatedAt: 1_999,
    }
    const base = {
      v: IDE_PROTOCOL_VERSION,
      type: 'ide.sessionInventory',
      streamId: 'daemon_boot_1',
      cursor: 42,
      generatedAt: 2_000,
    }

    expect(IdeSessionInventorySchema.safeParse({ ...base, sessions: [session] }).success).toBe(false)
    expect(
      IdeSessionInventorySchema.safeParse({
        ...base,
        sessions: [
          { ...session, attention: undefined },
          { ...session, attention: undefined },
        ],
      }).success,
    ).toBe(false)
  })
})
