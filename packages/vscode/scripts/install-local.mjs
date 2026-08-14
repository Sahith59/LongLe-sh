import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const artifactPath = path.join(packageRoot, 'dist-vsix', `longleash-vscode-${manifest.version}.vsix`)
let executable = 'code'
let dryRun = false

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === '--') continue
  if (argument === '--dry-run') {
    dryRun = true
    continue
  }
  if (argument === '--code') {
    const value = process.argv[index + 1]
    if (value === undefined || value.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('--code requires a safe executable name or absolute path')
    }
    executable = value
    index += 1
    continue
  }
  throw new Error(`Unknown argument: ${argument}`)
}

const args = ['--install-extension', artifactPath, '--force']
if (dryRun) {
  process.stdout.write(
    `${JSON.stringify({ executable, args, artifact: path.basename(artifactPath), version: manifest.version, executed: false })}\n`,
  )
  process.exit(0)
}

if (!existsSync(artifactPath)) {
  throw new Error(`VSIX not found. Run pnpm vscode:package first: ${artifactPath}`)
}
execFileSync(executable, args, { stdio: 'inherit' })
process.stdout.write('LongLeash installed or updated. Reload the intended VS Code window before using it.\n')
