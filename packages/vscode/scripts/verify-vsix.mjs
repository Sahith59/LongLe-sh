import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const defaultPath = path.join(packageRoot, 'dist-vsix', `longleash-vscode-${manifest.version}.vsix`)
const supplied = process.argv[2]
const artifactPath = supplied === undefined ? defaultPath : path.resolve(process.cwd(), supplied)
const bytes = statSync(artifactPath).size
if (bytes < 1_024 || bytes > 5 * 1_024 * 1_024) {
  throw new Error(`VSIX size is outside the verified bounds: ${bytes} bytes`)
}
const archive = new AdmZip(artifactPath)
const archiveEntries = archive.getEntries()
const entries = archiveEntries.map((entry) => entry.entryName)
const expandedBytes = archiveEntries.reduce((total, entry) => total + entry.header.size, 0)
if (expandedBytes > 2 * 1_024 * 1_024) {
  throw new Error(`VSIX expands beyond the verified bound: ${expandedBytes} bytes`)
}

const required = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension/package.nls.json',
  'extension/dist/extension.cjs',
  'extension/assets/longleash.svg',
]
for (const name of required) {
  if (!entries.includes(name)) throw new Error(`VSIX is missing required entry: ${name}`)
}

const forbidden = entries.filter((name) =>
  /(?:^|\/)(?:src|test|test-host|scripts|node_modules|\.vscode-test)(?:\/|$)|\.map$/u.test(name),
)
if (forbidden.length > 0) {
  throw new Error(`VSIX contains development-only entries: ${forbidden.join(', ')}`)
}
if (entries.length > 16) throw new Error(`VSIX contains an unexpected number of entries: ${entries.length}`)
const packagedManifest = JSON.parse(archive.readAsText('extension/package.json'))
if (
  packagedManifest.name !== 'longleash' ||
  packagedManifest.publisher !== 'longleash' ||
  packagedManifest.version !== manifest.version ||
  packagedManifest.main !== './dist/extension.cjs'
) {
  throw new Error('The packaged extension identity or entry point does not match the source manifest')
}

const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')

process.stdout.write(
  `${JSON.stringify({ artifact: path.basename(artifactPath), bytes, expandedBytes, entries: entries.length, sha256, verified: true })}\n`,
)
