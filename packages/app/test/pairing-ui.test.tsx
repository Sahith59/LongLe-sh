import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairingVerification } from '../src/ui/PairingVerification.js'
import { parsePairingLink } from '../src/App.js'
it('renders readable verification with explicit positive and negative decisions', () => {
  const html = renderToStaticMarkup(<PairingVerification progress={{ state: 'compare', code: '1234 5678', expiresAt: Date.now() + 60_000 }} control={{ confirm() {}, reject() {} }} onCancel={() => {}} />)
  expect(html).toContain('Codes match')
  expect(html).toContain('They do not match')
  expect(html).toContain('Verification code 1 2 3 4 5 6 7 8')
  expect(html).toContain('role="status"')
})
it('waiting does not offer a second confirmation', () => {
  const html = renderToStaticMarkup(<PairingVerification progress={{ state: 'waiting' }} control={null} onCancel={() => {}} />)
  expect(html).toContain('Confirm on your laptop')
  expect(html).not.toContain('>Codes match<')
  expect(html).toContain('Cancel pairing')
})
it('preserves explicit pairing version while recognizing legacy links for update guidance', () => {
  expect(parsePairingLink('https://app.longleash.dev/#c=chl_test&s=secret&v=2')).toEqual({ challengeId: 'chl_test', secret: 'secret', version: 2 })
  expect(parsePairingLink('#c=old&s=secret')?.version).toBeUndefined()
})
