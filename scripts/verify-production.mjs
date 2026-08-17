#!/usr/bin/env node

/**
 * Read-only production acceptance checks. This intentionally never pairs a device, creates an
 * account, opens a relay room, or logs a credential. Those flows remain part of the physical
 * acceptance matrix in docs/ACCOUNT-LAUNCH.md.
 */

const expectedCommit = process.env.EXPECTED_BUILD ?? process.argv[2] ?? ''
const apex = 'https://longleash.dev'
const app = 'https://app.longleash.dev'
const legacy = 'https://longleash-relay.tsahith59.workers.dev'
const timeoutMs = 10_000

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function request(url, init = {}) {
  return fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
}

async function expectStatus(url, status, init) {
  const response = await request(url, init)
  assert(response.status === status, `${url}: expected ${status}, received ${response.status}`)
  return response
}

async function expectPermanentRedirect(url, target) {
  const response = await expectStatus(url, 308, { redirect: 'manual' })
  assert(response.headers.get('location') === target, `${url}: unexpected redirect target`)
}

async function expectTlsReachable(url) {
  const response = await request(url, { redirect: 'manual' })
  assert(response.status >= 200 && response.status < 500, `${url}: TLS endpoint is unavailable (${response.status})`)
}

function verifySecurityHeaders(response, label) {
  const csp = response.headers.get('content-security-policy') ?? ''
  assert(csp.includes("default-src 'self'"), `${label}: missing restrictive CSP`)
  assert(!csp.includes("'unsafe-eval'"), `${label}: CSP permits unsafe-eval`)
  assert(response.headers.get('x-content-type-options') === 'nosniff', `${label}: missing nosniff`)
  assert(response.headers.get('x-frame-options') === 'DENY', `${label}: missing frame denial`)
  assert(response.headers.get('referrer-policy') === 'no-referrer', `${label}: unsafe referrer policy`)
  assert((response.headers.get('permissions-policy') ?? '').includes('camera=(self)'), `${label}: camera policy drifted`)
}

async function main() {
  for (const path of ['/', '/docs', '/docs/security', '/docs/troubleshooting', '/privacy', '/terms']) {
    await expectStatus(`${apex}${path}`, 200)
  }

  const siteResponse = await expectStatus(`${apex}/`, 200)
  const appResponse = await expectStatus(`${app}/`, 200)
  verifySecurityHeaders(siteResponse, 'public site')
  verifySecurityHeaders(appResponse, 'app')

  await expectPermanentRedirect(`https://www.longleash.dev/docs?source=ci`, `${apex}/docs?source=ci`)
  await expectPermanentRedirect(`${apex}/app`, `${app}/`)
  await expectPermanentRedirect(`${legacy}/`, `${app}/`)

  const health = await (await expectStatus(`${app}/health`, 200)).json()
  assert(health.ok === true && health.role === 'relay', 'app health does not identify a healthy relay')
  assert(health.accountRequired === true, 'production app is not account-gated')

  const legacyHealth = await (await expectStatus(`${legacy}/health`, 200)).json()
  assert(legacyHealth.ok === true && legacyHealth.role === 'relay', 'legacy relay health failed')

  const auth = await (await expectStatus(`${app}/api/auth/config`, 200)).json()
  assert(auth.required === true && auth.ready === true, 'production authentication is not ready')
  assert(typeof auth.publishableKey === 'string' && auth.publishableKey.startsWith('pk_live_'), 'production Clerk key is not live')

  await expectStatus(`${app}/api/relay-ticket`, 403, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  await expectStatus(`${app}/api/relay-ticket`, 401, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app },
    body: '{}',
  })

  const build = await (await expectStatus(`${app}/build.json?verify=${Date.now()}`, 200)).json()
  assert(typeof build.build === 'string' && build.build.length >= 7, 'production build stamp is missing')
  if (expectedCommit) {
    assert(expectedCommit.startsWith(build.build), `production serves ${build.build}, expected commit ${expectedCommit}`)
  }

  // Any non-server-error HTTPS response proves Node accepted the certificate chain and hostname.
  // Clerk may challenge a non-browser client at the Account Portal root, so a 403 is reachable,
  // not an authentication failure in LongLeash.
  await expectStatus('https://clerk.longleash.dev/v1/environment', 200)
  await expectTlsReachable('https://accounts.longleash.dev/')

  console.log(`Production matrix passed for build ${build.build}.`)
  console.log('Verified: branded routes, legacy compatibility, TLS, security headers, auth readiness, and unauthenticated API boundaries.')
}

main().catch((error) => {
  console.error(`Production matrix failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
