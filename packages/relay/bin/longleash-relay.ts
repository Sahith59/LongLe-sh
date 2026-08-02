import { RelayServer } from '../src/server.js'

/**
 * The public rendezvous service. This is the one LongLeash process that is MEANT to bind a
 * public interface — it runs on a VPS, not on anyone's laptop, and the only thing it can leak
 * is that ciphertext moved. The daemon-side rule ("nothing binds 0.0.0.0") is about the
 * machine that holds your code and credentials; this box holds neither.
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const host = process.env.LONGLEASH_RELAY_HOST ?? '0.0.0.0'
const port = Number(process.env.LONGLEASH_RELAY_PORT ?? 8080)

// Serve the app shell when it is around (the deploy image bakes it in; a bare relay works
// without it). This is what makes the relay origin a place a phone can LIVE, not just talk.
const here = dirname(fileURLToPath(import.meta.url))
const defaultStatic = resolve(here, '../../app/dist')
const staticDir = process.env.LONGLEASH_RELAY_STATIC ?? (existsSync(defaultStatic) ? defaultStatic : undefined)

const server = new RelayServer({
  host,
  port,
  ...(staticDir === undefined ? {} : { staticDir }),
  log: (line) => console.log(`[relay] ${line}`),
})

const listening = await server.listen()
console.log(`[relay] listening on ${host}:${listening} — ciphertext in, ciphertext out, nothing kept`)
console.log(staticDir ? `[relay] serving the app shell from ${staticDir}` : '[relay] no app shell (routing only)')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0))
  })
}
