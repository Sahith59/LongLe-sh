export interface SafeExtensionDiagnostics {
  schema: 1
  extensionVersion: string
  extensionBuild: string
  vscodeVersion: string
  uriScheme: string
  remote: boolean
  workspaceTrusted: boolean
  windowFocused: boolean
  workspaceFolderCount: number
  claudeExtension: {
    installed: boolean
    version?: string
    nativeSessionDispatchVerified: boolean
  }
  codexExtension: { installed: boolean; version?: string }
}

/**
 * Diagnostics are constructed from an allowlist, not cleaned after the fact. There is nowhere for
 * prompts, paths, native conversation ids, tokens, provider URLs, or raw exception strings to
 * enter this object.
 */
export function createSafeDiagnostics(input: SafeExtensionDiagnostics): SafeExtensionDiagnostics {
  return {
    schema: 1,
    extensionVersion: bounded(input.extensionVersion),
    extensionBuild: bounded(input.extensionBuild),
    vscodeVersion: bounded(input.vscodeVersion),
    uriScheme: bounded(input.uriScheme),
    remote: input.remote,
    workspaceTrusted: input.workspaceTrusted,
    windowFocused: input.windowFocused,
    workspaceFolderCount: Math.max(0, Math.min(64, Math.trunc(input.workspaceFolderCount))),
    claudeExtension: claudeProvider(input.claudeExtension),
    codexExtension: provider(input.codexExtension),
  }
}

export function serializeSafeDiagnostics(input: SafeExtensionDiagnostics): string {
  return JSON.stringify(createSafeDiagnostics(input), null, 2)
}

function provider(value: { installed: boolean; version?: string }): {
  installed: boolean
  version?: string
} {
  return value.version === undefined
    ? { installed: value.installed }
    : { installed: value.installed, version: bounded(value.version) }
}

function claudeProvider(value: {
  installed: boolean
  version?: string
  nativeSessionDispatchVerified: boolean
}): {
  installed: boolean
  version?: string
  nativeSessionDispatchVerified: boolean
} {
  return {
    ...provider(value),
    nativeSessionDispatchVerified: value.nativeSessionDispatchVerified,
  }
}

function bounded(value: string): string {
  // Version/build labels are never allowed to become a covert channel for arbitrary diagnostics.
  // Reject the entire value rather than deleting suspicious separators and accidentally retaining
  // a token or query value on the other side of them.
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,119}$/u.test(value) ? value : 'invalid'
}
