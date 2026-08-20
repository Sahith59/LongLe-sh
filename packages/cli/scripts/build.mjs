import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '../..')
const bin = resolve(root, 'bin')
const runtime = resolve(root, 'runtime')
rmSync(bin, { recursive: true, force: true })
rmSync(runtime, { recursive: true, force: true })
mkdirSync(bin, { recursive: true })
mkdirSync(resolve(runtime, 'daemon/bin'), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(bin, 'longleash.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22.14',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
})

const daemon = await build({
  entryPoints: [resolve(repo, 'packages/daemon/bin/longleashd.ts')],
  outfile: resolve(runtime, 'daemon/bin/longleashd.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22.14',
  format: 'esm',
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@fastify/static',
    '@fastify/websocket',
    'better-sqlite3',
    'fastify',
    'qrcode-terminal',
    'web-push',
    'ws',
  ],
  legalComments: 'none',
  metafile: true,
})

const bundledPackages = new Set()
for (const input of Object.keys(daemon.metafile.inputs)) {
  const marker = '/node_modules/'
  const index = input.lastIndexOf(marker)
  if (index < 0) continue
  const parts = input.slice(index + marker.length).split('/')
  bundledPackages.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0])
}
const noticedPackages = new Set(['@noble/ciphers', '@noble/hashes', 'zod'])
const unexpected = [...bundledPackages].filter((name) => !noticedPackages.has(name))
const missing = [...noticedPackages].filter((name) => !bundledPackages.has(name))
if (unexpected.length > 0 || missing.length > 0) {
  throw new Error(`Bundled third-party notice mismatch. Unexpected: ${unexpected.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`)
}

cpSync(resolve(repo, 'packages/daemon/hooks'), resolve(runtime, 'daemon/hooks'), { recursive: true })
cpSync(resolve(repo, 'packages/daemon/bin/longleash-devices.mjs'), resolve(runtime, 'daemon/bin/longleash-devices.mjs'))
cpSync(resolve(repo, 'packages/app/dist'), resolve(runtime, 'app/dist'), { recursive: true })
