export interface ProviderCompatibilityRecord {
  provider: 'claude' | 'codex'
  component: 'vscode-extension' | 'cli-app-server'
  version: string
  testedAt: string
  capabilities: {
    diagnostics: boolean
    exactHistoryRead: boolean
    nativeSessionDispatch: boolean
    readWithoutLoading: boolean
  }
  evidence: 'live-pass' | 'live-fail'
}

/**
 * Evidence ledger, not a version allowlist guessed from semver. A capability becomes available
 * only when that exact provider build passed the corresponding disposable live matrix.
 */
export const PROVIDER_COMPATIBILITY_LEDGER: readonly ProviderCompatibilityRecord[] = [
  {
    provider: 'claude',
    component: 'vscode-extension',
    version: '2.1.229',
    testedAt: '2026-08-12',
    capabilities: {
      diagnostics: true,
      exactHistoryRead: false,
      nativeSessionDispatch: false,
      readWithoutLoading: false,
    },
    evidence: 'live-fail',
  },
  {
    provider: 'codex',
    component: 'cli-app-server',
    version: '0.147.0',
    testedAt: '2026-08-12',
    capabilities: {
      diagnostics: true,
      exactHistoryRead: true,
      nativeSessionDispatch: false,
      readWithoutLoading: true,
    },
    evidence: 'live-pass',
  },
]

export function claudeNativeDispatchVerified(version: string | undefined): boolean {
  if (version === undefined) return false
  return PROVIDER_COMPATIBILITY_LEDGER.some(
    (record) =>
      record.provider === 'claude' &&
      record.component === 'vscode-extension' &&
      record.version === version &&
      record.evidence === 'live-pass' &&
      record.capabilities.nativeSessionDispatch &&
      record.capabilities.exactHistoryRead,
  )
}

export function codexReadWithoutLoadingVerified(version: string | undefined): boolean {
  if (version === undefined) return false
  return PROVIDER_COMPATIBILITY_LEDGER.some(
    (record) =>
      record.provider === 'codex' &&
      record.component === 'cli-app-server' &&
      record.version === version &&
      record.evidence === 'live-pass' &&
      record.capabilities.exactHistoryRead &&
      record.capabilities.readWithoutLoading,
  )
}
