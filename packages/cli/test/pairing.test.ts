import { describe, expect, it, vi } from 'vitest'
import { runVerifiedPairing } from '../src/pairing.js'
const init = { url: 'https://example.test/#c=test&s=private&v=2', version: 2, challengeId: 'test', expiresAt: Date.now() + 300_000 }
function harness(answer = 'no') {
  const request = vi.fn(async (path: string) => Response.json(path === '/local/pairing' ? init : { verification: { attemptId: 'A'.repeat(43), code: '1234 5678' } }))
  return { interactive: true, request, print: vi.fn(), showQr: vi.fn(), ask: vi.fn(async () => answer), signal: new AbortController().signal }
}
describe('interactive laptop pairing', () => {
  it('refuses non-TTY before generating or printing secrets', async () => {
    const h = harness(); h.interactive = false
    await expect(runVerifiedPairing(h)).rejects.toThrow(/interactive/)
    expect(h.request).not.toHaveBeenCalled(); expect(h.showQr).not.toHaveBeenCalled()
  })
  it('requires an explicit yes and cancels mismatch', async () => {
    const h = harness()
    await expect(runVerifiedPairing(h)).rejects.toThrow(/not confirmed/)
    expect(h.request.mock.calls.map(([path]) => path)).toEqual(['/local/pairing', '/local/pairing/status', '/local/pairing/cancel'])
  })
  it('refuses old daemons before printing their unverified QR', async () => {
    const h = harness(); h.request.mockImplementation(async () => Response.json({ url: init.url }))
    await expect(runVerifiedPairing(h)).rejects.toThrow(/Update and restart/)
    expect(h.showQr).not.toHaveBeenCalled()
  })
  it('cancels on Ctrl-C while waiting for local input', async () => {
    const h = harness(); const controller = new AbortController(); h.signal = controller.signal
    h.ask.mockImplementation(async () => { controller.abort(); return 'yes' })
    await expect(runVerifiedPairing(h)).rejects.toThrow(/cancelled or expired/)
    expect(h.request.mock.calls.at(-1)?.[0]).toBe('/local/pairing/cancel')
    expect(h.request.mock.calls.some(([path]) => path.endsWith('/confirm'))).toBe(false)
  })
})
