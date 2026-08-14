import { describe, expect, it } from 'vitest'
import { createSafeDiagnostics, serializeSafeDiagnostics } from '../src/diagnostics.js'

describe('safe extension diagnostics', () => {
  it('copies only allowlisted compatibility evidence', () => {
    const hostile = {
      schema: 1 as const,
      extensionVersion: '0.0.1?token=secret',
      extensionBuild: 'build/path',
      vscodeVersion: '1.131.0',
      uriScheme: 'vscode',
      remote: false,
      workspaceTrusted: true,
      windowFocused: true,
      workspaceFolderCount: 999,
      claudeExtension: {
        installed: true,
        version: '2.1.229',
        nativeSessionDispatchVerified: false,
      },
      codexExtension: { installed: true, version: '26.803.61601' },
      prompt: 'private prompt',
      token: 'bearer-secret',
      path: '/Users/private/project',
      nativeId: 'thread-private',
    }

    const serialized = serializeSafeDiagnostics(hostile)
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    expect(parsed).toEqual({
      schema: 1,
      extensionVersion: 'invalid',
      extensionBuild: 'invalid',
      vscodeVersion: '1.131.0',
      uriScheme: 'vscode',
      remote: false,
      workspaceTrusted: true,
      windowFocused: true,
      workspaceFolderCount: 64,
      claudeExtension: {
        installed: true,
        version: '2.1.229',
        nativeSessionDispatchVerified: false,
      },
      codexExtension: { installed: true, version: '26.803.61601' },
    })
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('/Users')
    expect(serialized).not.toContain('thread-private')
  })

  it('does not invent a provider version when one is unavailable', () => {
    expect(
      createSafeDiagnostics({
        schema: 1,
        extensionVersion: '0.0.1',
        extensionBuild: 'dev',
        vscodeVersion: '1.131.0',
        uriScheme: 'vscode',
        remote: false,
        workspaceTrusted: false,
        windowFocused: false,
        workspaceFolderCount: 0,
        claudeExtension: { installed: false, nativeSessionDispatchVerified: false },
        codexExtension: { installed: false },
      }),
    ).toMatchObject({
      claudeExtension: { installed: false, nativeSessionDispatchVerified: false },
      codexExtension: { installed: false },
    })
  })
})
