import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  throw new Error('The extension manifest must contain a valid release version')
}

const outputDirectory = path.join(packageRoot, 'dist-vsix')
const outputPath = path.join(outputDirectory, `longleash-vscode-${manifest.version}.vsix`)
mkdirSync(outputDirectory, { recursive: true })

execFileSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vsce', 'package', '--no-dependencies', '--out', outputPath],
  { cwd: packageRoot, stdio: 'inherit' },
)

const bytes = statSync(outputPath).size
if (bytes < 1_024 || bytes > 5 * 1_024 * 1_024) {
  throw new Error(`Unexpected VSIX size: ${bytes} bytes`)
}
process.stdout.write(`${outputPath}\n`)
