import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'npm-shrinkwrap.json')
const workspaceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const releaseManifest = { ...workspaceManifest }
delete releaseManifest.devDependencies
delete releaseManifest.scripts

const npmEnv = { ...process.env }
for (const name of Object.keys(npmEnv)) {
  if (name.toLowerCase().startsWith('npm_config_')) delete npmEnv[name]
}

const stage = mkdtempSync(join(tmpdir(), 'longleash-shrinkwrap-'))
try {
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`)
  if (process.argv.includes('--check')) {
    // Validate the committed graph instead of resolving a new graph from today's registry.
    // Re-resolving here makes a release candidate non-reproducible whenever a transitive range
    // gains a newer version. npm still checks that this lock satisfies the release manifest and
    // rewrites it if the manifest and shrinkwrap have drifted.
    copyFileSync(destination, join(stage, 'package-lock.json'))
  }
  execFileSync('npm', [
    'install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org/',
  ], { cwd: stage, stdio: 'ignore', env: npmEnv })
  const generated = join(stage, 'package-lock.json')
  const lock = JSON.parse(readFileSync(generated, 'utf8'))
  if (lock.lockfileVersion !== 3 || lock.packages?.['']?.name !== workspaceManifest.name || lock.packages?.['']?.version !== workspaceManifest.version) {
    throw new Error('Generated npm shrinkwrap does not describe this package exactly.')
  }

  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== readFileSync(generated, 'utf8')) {
      throw new Error('npm-shrinkwrap.json is stale. Run `pnpm --filter @longleash/cli shrinkwrap:generate`.')
    }
  } else {
    copyFileSync(generated, destination)
    console.log(`Wrote ${destination}`)
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}
