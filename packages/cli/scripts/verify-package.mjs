import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-pack')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const npmEnv = { ...process.env }
for (const name of Object.keys(npmEnv)) {
  if (name.toLowerCase().startsWith('npm_config_')) delete npmEnv[name]
}
const npm = (args) => JSON.parse(execFileSync('npm', args, { cwd: root, encoding: 'utf8', env: npmEnv }))
const dry = npm(['pack', '--dry-run', '--json', '--ignore-scripts'])
const candidate = dry[0]
if (!candidate || !Array.isArray(candidate.files)) throw new Error('npm pack did not return a file manifest.')

const names = candidate.files.map((file) => file.path).sort()
const required = [
  'LICENSE',
  'npm-shrinkwrap.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'bin/longleash.mjs',
  'package.json',
  'runtime/app/dist/index.html',
  'runtime/daemon/bin/longleash-devices.mjs',
  'runtime/daemon/bin/longleashd.mjs',
  'runtime/daemon/hooks/install-codex-hooks.mjs',
  'runtime/daemon/hooks/install-hooks.mjs',
  'runtime/daemon/hooks/longleash-codex-hook.mjs',
  'runtime/daemon/hooks/longleash-hook.mjs',
]
for (const file of required) {
  if (!names.includes(file)) throw new Error(`Required package file is missing: ${file}`)
}

const allowed = /^(?:LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|npm-shrinkwrap\.json|package\.json|bin\/longleash\.mjs|runtime\/app\/dist\/[A-Za-z0-9._/-]+|runtime\/daemon\/bin\/(?:longleashd\.mjs|longleash-devices\.mjs)|runtime\/daemon\/hooks\/[A-Za-z0-9.-]+)$/
for (const name of names) {
  if (!allowed.test(name)) throw new Error(`Unexpected file in npm package: ${name}`)
  if (/(?:^|\/)(?:\.env|\.git|node_modules|test|tests|coverage|\.wrangler)(?:\/|$)|\.(?:db|sqlite|log|pem|key)$/i.test(name)) {
    throw new Error(`Sensitive or development file in npm package: ${name}`)
  }
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bgh[psour]_[A-Za-z0-9]{30,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
]
for (const name of names) {
  const path = join(root, name)
  const body = readFileSync(path)
  if (body.includes(0)) continue
  const text = body.toString('utf8')
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) throw new Error(`Possible credential material in npm package: ${name}`)
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (manifest.name !== '@longleash/cli') throw new Error('Package name changed unexpectedly.')
if (manifest.private === true) throw new Error('CLI package is marked private.')
if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
  throw new Error('Public access and provenance must remain explicit.')
}
if (manifest.repository?.url !== 'https://github.com/Sahith59/LongLe-sh.git') {
  throw new Error('Repository URL must exactly match the trusted-publisher repository.')
}
for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
  if (manifest.scripts?.[lifecycle]) throw new Error(`Install-time lifecycle script is forbidden: ${lifecycle}`)
}
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    throw new Error(`Runtime dependency must be exact: ${name}@${version}`)
  }
}
const shrinkwrap = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'))
if (shrinkwrap.lockfileVersion !== 3 || shrinkwrap.packages?.['']?.name !== manifest.name || shrinkwrap.packages?.['']?.version !== manifest.version) {
  throw new Error('npm shrinkwrap identity does not match the release manifest.')
}
const lockedDirect = shrinkwrap.packages[''].dependencies ?? {}
if (
  Object.keys(lockedDirect).length !== Object.keys(manifest.dependencies ?? {}).length ||
  Object.entries(manifest.dependencies ?? {}).some(([name, version]) => lockedDirect[name] !== version)
) {
  throw new Error('npm shrinkwrap direct dependencies do not match the release manifest.')
}
for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
  if (path === '') continue
  if (!entry.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')) {
    throw new Error(`Shrinkwrapped dependency lacks official-registry SHA-512 integrity: ${path}`)
  }
}
if (candidate.unpackedSize > 8 * 1024 * 1024) throw new Error(`Package unexpectedly exceeds 8 MiB: ${candidate.unpackedSize}`)

const packed = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', out])[0]
const tarball = join(out, packed.filename)
console.log(JSON.stringify({ tarball, files: names.length, unpackedSize: candidate.unpackedSize, integrity: packed.integrity }, null, 2))
