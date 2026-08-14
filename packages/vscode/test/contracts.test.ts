import { describe, expect, it } from 'vitest'
import {
  IDE_PROTOCOL_VERSION,
  type IdeCapability,
  type IdeClientHello,
  type IdeOpenSessionInstruction,
} from '@longleash/protocol'
import {
  MIN_TESTED_CLAUDE_EXTENSION_VERSION,
  buildClaudeSessionUri,
  compareVersions,
  negotiateCapabilities,
  planClaudeOpen,
  planCodexEditor,
} from '../src/contracts.js'

const allCapabilities: IdeCapability[] = [
  'diagnostics.read',
  'sessions.read',
  'transcripts.read',
  'workspace.open',
  'file.open',
  'claude.dispatch',
  'codex.render',
  'approvals.decide',
  'sessions.message',
  'sessions.stop',
  'sessions.delegate',
  'delegations.return',
]

function client(overrides: Partial<IdeClientHello['vscode']> = {}): IdeClientHello {
  return {
    v: IDE_PROTOCOL_VERSION,
    type: 'ide.hello',
    clientInstanceId: 'window_1',
    protocol: { min: 1, max: 1 },
    extension: { version: '0.0.1', build: 'build_1' },
    vscode: {
      version: '1.131.0',
      uriScheme: 'vscode',
      remoteAuthority: null,
      workspaceTrusted: true,
      windowFocused: true,
      workspaceFolders: [
        { uri: 'file:///Users/example/project', canonicalPath: '/Users/example/project' },
      ],
      ...overrides,
    },
    capabilities: allCapabilities,
  }
}

function instruction(
  provider: 'claude' | 'codex' = 'claude',
  overrides: Partial<IdeOpenSessionInstruction> = {},
): IdeOpenSessionInstruction {
  return {
    v: IDE_PROTOCOL_VERSION,
    type: 'ide.openSession',
    operationId: 'op_1',
    issuedAt: 10_000,
    expiresAt: 40_000,
    provider,
    sessionId: 'longleash_1',
    nativeId: `${provider}_native_1`,
    canonicalWorkspace: '/Users/example/project',
    destination: provider === 'claude' ? 'claude-native' : 'codex-longleash',
    nativeRecord: {
      verifiedAt: 9_999,
      canonicalWorkspace: '/Users/example/project',
    },
    ownership: 'ide-reserved',
    ...overrides,
  }
}

describe('companion capability negotiation', () => {
  it('grants only the intersection for an active compatible principal', () => {
    const result = negotiateCapabilities({
      client: client(),
      serverProtocol: { min: 1, max: 2 },
      serverCapabilities: ['diagnostics.read', 'sessions.read', 'sessions.stop'],
      credential: 'active',
      expectedExtensionBuild: 'build_1',
    })

    expect(result).toEqual({
      accepted: true,
      selectedProtocol: 1,
      capabilities: ['diagnostics.read', 'sessions.read', 'sessions.stop'],
      mutationMode: 'enabled',
    })
  })

  it('fails closed for revoked credentials and incompatible protocols', () => {
    expect(
      negotiateCapabilities({
        client: client(),
        serverProtocol: { min: 1, max: 1 },
        serverCapabilities: allCapabilities,
        credential: 'revoked',
      }),
    ).toMatchObject({ accepted: false, reason: 'credential-revoked', capabilities: [] })

    expect(
      negotiateCapabilities({
        client: { ...client(), protocol: { min: 2, max: 3 } },
        serverProtocol: { min: 1, max: 1 },
        serverCapabilities: allCapabilities,
        credential: 'active',
      }),
    ).toMatchObject({ accepted: false, reason: 'protocol-incompatible', capabilities: [] })
  })

  it('leaves only diagnostics in an untrusted workspace', () => {
    const result = negotiateCapabilities({
      client: client({ workspaceTrusted: false }),
      serverProtocol: { min: 1, max: 1 },
      serverCapabilities: allCapabilities,
      credential: 'active',
    })

    expect(result).toMatchObject({
      accepted: true,
      reason: 'workspace-untrusted',
      capabilities: ['diagnostics.read'],
      mutationMode: 'read-only',
    })
  })

  it('removes every mutation on a build mismatch', () => {
    const result = negotiateCapabilities({
      client: client(),
      serverProtocol: { min: 1, max: 1 },
      serverCapabilities: allCapabilities,
      credential: 'active',
      expectedExtensionBuild: 'build_2',
    })

    expect(result).toMatchObject({
      accepted: true,
      reason: 'build-mismatch',
      capabilities: ['diagnostics.read', 'sessions.read', 'transcripts.read'],
      mutationMode: 'read-only',
    })
  })
})

describe('Claude native-session preflight', () => {
  const provider = { installed: true, version: MIN_TESTED_CLAUDE_EXTENSION_VERSION }

  it('passes structural preflight but blocks a build that failed exact-history verification', () => {
    expect(
      planClaudeOpen({
        instruction: instruction(),
        client: client(),
        grantedCapabilities: allCapabilities,
        provider,
        now: 10_001,
      }),
    ).toEqual({ kind: 'blocked', code: 'provider-contract-unverified' })
  })

  it('supports a session nested beneath one root in a multi-root workspace', () => {
    const multi = client({
      workspaceFolders: [
        { uri: 'file:///Users/example/other', canonicalPath: '/Users/example/other' },
        { uri: 'file:///Users/example/project', canonicalPath: '/Users/example/project' },
      ],
    })
    expect(
      planClaudeOpen({
        instruction: instruction('claude', {
          canonicalWorkspace: '/Users/example/project/packages/app',
          nativeRecord: {
            verifiedAt: 9_999,
            canonicalWorkspace: '/Users/example/project/packages/app',
          },
        }),
        client: multi,
        grantedCapabilities: allCapabilities,
        provider,
        now: 10_001,
      }),
    ).toEqual({ kind: 'blocked', code: 'provider-contract-unverified' })
  })

  it.each([
    ['workspace-untrusted', client({ workspaceTrusted: false }), instruction()],
    ['window-not-focused', client({ windowFocused: false }), instruction()],
    ['editor-scheme-unsupported', client({ uriScheme: 'vscode-insiders' }), instruction()],
    ['remote-workspace-unsupported', client({ remoteAuthority: 'ssh-remote+host' }), instruction()],
    [
      'workspace-mismatch',
      client({
        workspaceFolders: [
          { uri: 'file:///Users/example/project-other', canonicalPath: '/Users/example/project-other' },
        ],
      }),
      instruction(),
    ],
    ['ownership-not-reserved', client(), instruction('claude', { ownership: 'read-only' })],
    [
      'native-session-unverified',
      client(),
      instruction('claude', {
        nativeRecord: { verifiedAt: 1, canonicalWorkspace: '/Users/example/project' },
      }),
    ],
  ] as const)('blocks %s before invoking the vendor URI', (code, currentClient, currentInstruction) => {
    expect(
      planClaudeOpen({
        instruction: currentInstruction,
        client: currentClient,
        grantedCapabilities: allCapabilities,
        provider,
        now: 10_001,
      }),
    ).toEqual({ kind: 'blocked', code })
  })

  it('blocks absent or below-tested provider builds', () => {
    expect(
      planClaudeOpen({
        instruction: instruction(),
        client: client(),
        grantedCapabilities: allCapabilities,
        provider: { installed: false },
        now: 10_001,
      }),
    ).toEqual({ kind: 'blocked', code: 'provider-missing' })
    expect(
      planClaudeOpen({
        instruction: instruction(),
        client: client(),
        grantedCapabilities: allCapabilities,
        provider: { installed: true, version: '2.1.228' },
        now: 10_001,
      }),
    ).toEqual({ kind: 'blocked', code: 'provider-too-old' })
  })

  it('fails closed when an installed provider build has not passed the live exact-history matrix', () => {
    expect(
      planClaudeOpen({
        instruction: instruction(),
        client: client(),
        grantedCapabilities: allCapabilities,
        provider: { installed: true, version: MIN_TESTED_CLAUDE_EXTENSION_VERSION },
        now: 10_001,
      }),
    ).toEqual({ kind: 'blocked', code: 'provider-contract-unverified' })
  })

  it('URL-encodes the session as data and never allows parameter injection', () => {
    const uri = new URL(buildClaudeSessionUri('abc&prompt=send-this'))
    expect(uri.searchParams.get('session')).toBe('abc&prompt=send-this')
    expect(uri.searchParams.has('prompt')).toBe(false)
    expect(() => buildClaudeSessionUri('bad\nsession')).toThrow()
  })
})

describe('Codex LongLeash-owned editor contract', () => {
  it('renders the exact daemon-owned mirror without creating a second app-server writer', () => {
    expect(
      planCodexEditor({
        instruction: instruction('codex'),
        client: client(),
        grantedCapabilities: allCapabilities,
        snapshot: {
          source: 'daemon-mirror',
          threadId: 'codex_native_1',
          status: 'idle',
          appServerOwner: 'daemon',
        },
        now: 10_001,
      }),
    ).toEqual({
      kind: 'open-editor',
      verification: 'extension-owned',
      mode: 'writable',
      threadId: 'codex_native_1',
    })
  })

  it('opens a daemon mirror read-only while ownership remains elsewhere', () => {
    expect(
      planCodexEditor({
        instruction: instruction('codex', { ownership: 'read-only' }),
        client: client(),
        grantedCapabilities: allCapabilities,
        snapshot: {
          source: 'daemon-mirror',
          threadId: 'codex_native_1',
          status: 'active',
          appServerOwner: 'daemon',
        },
        now: 10_001,
      }),
    ).toMatchObject({ kind: 'open-editor', mode: 'read-only' })
  })

  it('blocks missing, mismatched, untrusted, and remote snapshots', () => {
    const common = {
      instruction: instruction('codex'),
      grantedCapabilities: allCapabilities,
      now: 10_001,
    }
    expect(planCodexEditor({ ...common, client: client() })).toEqual({
      kind: 'blocked',
      code: 'thread-snapshot-missing',
    })
    expect(
      planCodexEditor({
        ...common,
        client: client(),
        snapshot: {
          source: 'daemon-mirror',
          threadId: 'wrong',
          status: 'idle',
          appServerOwner: 'daemon',
        },
      }),
    ).toEqual({ kind: 'blocked', code: 'thread-snapshot-mismatch' })
    expect(planCodexEditor({ ...common, client: client({ workspaceTrusted: false }) })).toEqual({
      kind: 'blocked',
      code: 'workspace-untrusted',
    })
    expect(
      planCodexEditor({ ...common, client: client({ remoteAuthority: 'ssh-remote+host' }) }),
    ).toEqual({ kind: 'blocked', code: 'remote-workspace-unsupported' })
  })
})

describe('capability version comparison', () => {
  it('sorts numeric stable builds and fails closed on unknown formats', () => {
    expect(compareVersions('2.1.229', '2.1.229')).toBe(0)
    expect(compareVersions('2.1.230', '2.1.229')).toBe(1)
    expect(compareVersions('2.1.228', '2.1.229')).toBe(-1)
    expect(compareVersions('2.1.229-beta.1', '2.1.229')).toBe(-1)
    expect(compareVersions('unknown', '2.1.229')).toBe(-1)
  })
})
