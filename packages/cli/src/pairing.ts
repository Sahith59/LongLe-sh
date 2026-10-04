/** Kept independent of process I/O so expiry, cancellation and confirmation are testable. */
export async function runVerifiedPairing(io: {
  interactive: boolean;
  request: (path: string, init: RequestInit) => Promise<Response>;
  showQr: (url: string) => void;
  print: (text: string) => void;
  ask: (prompt: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  wait?: () => Promise<void>;
}): Promise<void> {
  if (!io.interactive) throw new Error('Pairing requires an interactive terminal. Run longleash pair without redirecting input or output.')
  if (io.signal.aborted) throw new Error('Pairing cancelled.')
  const response = await io.request('/local/pairing', { method: 'POST' })
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many QRs. Wait one minute and retry.' : 'Could not create a QR. Update/restart the daemon and try again.')
  const body = await response.json() as { url?: string; version?: number; challengeId?: string; expiresAt?: number }
  if (body.version !== 2 || !body.url || !body.challengeId || !body.expiresAt || !/^https?:\/\//.test(body.url)) {
    throw new Error('Update and restart the laptop daemon: this CLI requires verified pairing v2.')
  }
  const request = (action: string, attemptId?: string) => io.request(`/local/pairing/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: body.challengeId, ...(attemptId ? { attemptId } : {}) }),
  })
  const lifetime = AbortSignal.any([io.signal, AbortSignal.timeout(Math.max(1, body.expiresAt - Date.now()))])
  let completed = false
  let confirmed = false
  try {
    io.showQr(body.url)
    io.print('Keep this terminal open. Keep the QR and link private; do not share screenshots.')
    while (!lifetime.aborted) {
      const status = await request('status')
      if (!status.ok) throw new Error('Pairing ended or expired. Generate a fresh QR.')
      const result = await status.json() as { state?: string; deviceId?: string; verification?: { attemptId: string; code: string } }
      if (result.state === 'paired') { completed = true; io.print('Both devices confirmed. Your phone is paired.'); return }
      if (result.verification && !confirmed) {
        const { attemptId, code } = result.verification
        if (!/^\d{4} \d{4}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(attemptId)) throw new Error('Invalid laptop verification response.')
        io.print(`Compare with your phone:  ${code}`)
        const answer = await io.ask('Do all digits match? Type yes to confirm, or anything else to cancel: ', lifetime)
        if (answer.trim().toLowerCase() !== 'yes') throw new Error('Codes were not confirmed. Pairing cancelled; generate a fresh QR.')
        if (lifetime.aborted) break
        if (!(await request('confirm', attemptId)).ok) throw new Error('This attempt ended before confirmation. Generate a fresh QR.')
        confirmed = true
        io.print('Laptop confirmed. Choose Codes match on your phone to finish.')
      }
      await (io.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 300))))()
    }
    throw new Error('Pairing cancelled or expired. Generate a fresh QR.')
  } finally {
    if (!completed) await request('cancel').catch(() => {})
  }
}
