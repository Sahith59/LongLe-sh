type EventType = 'paired' | 'approval' | 'reply' | 'stop' | 'handoff' | 'tuning' | 'delegation'
type EventOutcome = 'success' | 'failure' | 'unknown'

let tokenProvider: (() => Promise<string | null>) | null = null
let enabled = false

export function configureMeasurement(provider: (() => Promise<string | null>) | null, consent = false): void {
  tokenProvider = provider
  enabled = provider !== null && consent
}

async function authenticated(path: string, init: RequestInit = {}) {
  if (!tokenProvider) throw new Error('Sign-in is required.')
  const token = await tokenProvider()
  if (!token) throw new Error('Sign-in expired.')
  return fetch(path, { ...init, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000), headers: {
    Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  } })
}

export async function readMeasurementConsent(): Promise<boolean> {
  const response = await authenticated('/api/measurement/consent')
  if (!response.ok) throw new Error('Measurement preference is unavailable.')
  const body = await response.json() as { enabled?: boolean }
  enabled = body.enabled === true
  return enabled
}

export async function writeMeasurementConsent(next: boolean): Promise<boolean> {
  const response = await authenticated('/api/measurement/consent', { method: 'PUT', body: JSON.stringify({ enabled: next }) })
  if (!response.ok) throw new Error(next ? 'Could not save opt-in. Nothing was collected.' : 'Could not confirm deletion. Please retry.')
  const body = await response.json() as { enabled?: boolean }
  enabled = body.enabled === true
  return enabled
}

/** Best-effort by design: measurement can never delay or fail a laptop action. */
export function recordMeasuredOutcome(type: EventType, outcome: EventOutcome): void {
  if (!enabled || !tokenProvider) return
  const event = { id: crypto.randomUUID(), type, outcome, occurredAt: Date.now(), build: __BUILD__ }
  void authenticated('/api/measurement/events', { method: 'POST', body: JSON.stringify(event) })
    .then(response => { if (response.status === 403) enabled = false })
    .catch(() => { /* Product control is independent from optional measurement. */ })
}
