import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'

// VS Code's integrated shell exports this for CLI helpers. A desktop extension-host process must
// not inherit it or Electron deliberately behaves like plain Node and never starts the workbench.
delete process.env.ELECTRON_RUN_AS_NODE

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testRunner = path.join(extensionRoot, 'dist', 'test-host', 'index.cjs')
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'longleash-v0-host-'))
const marker = path.join(fixtureRoot, 'no-production-mutation.marker')
const version = process.env.LONGLEASH_V0_VSCODE_VERSION ?? '1.131.0'
let vscodeExecutablePath

function command(program, args, cwd) {
  execFileSync(program, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
}

function newestClaudeExtension() {
  const extensionsRoot = path.join(homedir(), '.vscode', 'extensions')
  const candidates = readdirSync(extensionsRoot)
    .filter((name) => /^anthropic\.claude-code-\d+\.\d+\.\d+-/u.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  const selected = candidates.at(-1)
  if (selected === undefined) throw new Error('Claude Code VS Code extension is not installed')
  return path.join(extensionsRoot, selected)
}

function createFolder(name) {
  const folder = path.join(fixtureRoot, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'fixture.txt'), `${name}\n`, { flag: 'wx' })
  return realpathSync(folder)
}

async function runCase({ caseId, target, expectedRoots, coordinationDir }) {
  const userData = path.join(fixtureRoot, `user-${caseId}`)
  const extensions = path.join(fixtureRoot, `extensions-${caseId}`)
  mkdirSync(userData, { recursive: true })
  mkdirSync(extensions, { recursive: true })
  const fixture = {
    caseId,
    expectedRoots,
    expectedTrusted: true,
    expectedRemote: false,
    expectedProvider: 'installed',
    ...(coordinationDir === undefined ? {} : { coordinationDir }),
  }
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: [extensionRoot, newestClaudeExtension()],
    extensionTestsPath: testRunner,
    extensionTestsEnv: {
      LONGLEASH_V0_HOST_CASE: JSON.stringify(fixture),
      LONGLEASH_V0_HOST_MARKER: marker,
    },
    launchArgs: [
      target,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      '--disable-telemetry',
    ],
  })
}

try {
  const resolvedByHarness = await downloadAndUnzipVSCode(version)
  const renamedMacExecutable = resolvedByHarness.endsWith(`${path.sep}Electron`)
    ? `${resolvedByHarness.slice(0, -'Electron'.length)}Code`
    : resolvedByHarness
  vscodeExecutablePath = existsSync(resolvedByHarness)
    ? resolvedByHarness
    : renamedMacExecutable
  if (!existsSync(vscodeExecutablePath)) {
    throw new Error(`VS Code test executable is missing: ${vscodeExecutablePath}`)
  }
  writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  const same = createFolder('same-window')
  const multiA = createFolder('multi-root-a')
  const multiB = createFolder('multi-root-b')
  const workspace = path.join(fixtureRoot, 'multi-root.code-workspace')
  writeFileSync(
    workspace,
    `${JSON.stringify({ folders: [{ path: multiA }, { path: multiB }] }, null, 2)}\n`,
    { flag: 'wx' },
  )

  const repository = createFolder('worktree-source')
  command('git', ['init', '-q'], repository)
  command('git', ['add', 'fixture.txt'], repository)
  command(
    'git',
    ['-c', 'user.name=LongLeash V0', '-c', 'user.email=v0@invalid', 'commit', '-qm', 'fixture'],
    repository,
  )
  const worktree = path.join(fixtureRoot, 'worktree-child')
  command('git', ['worktree', 'add', '-qb', 'phase2a-fixture', worktree], repository)

  await runCase({ caseId: 'same', target: same, expectedRoots: [same] })
  await runCase({ caseId: 'multi-root', target: workspace, expectedRoots: [multiA, multiB] })
  await runCase({
    caseId: 'worktree',
    target: realpathSync(worktree),
    expectedRoots: [realpathSync(worktree)],
  })

  const windowA = createFolder('multi-window-a')
  const windowB = createFolder('multi-window-b')
  const coordinationDir = path.join(fixtureRoot, 'window-barrier')
  await Promise.all([
    runCase({ caseId: 'window-a', target: windowA, expectedRoots: [windowA], coordinationDir }),
    runCase({ caseId: 'window-b', target: windowB, expectedRoots: [windowB], coordinationDir }),
  ])
  const focusResults = readdirSync(coordinationDir)
    .filter((name) => name.endsWith('.result.json'))
    .map((name) => JSON.parse(readFileSync(path.join(coordinationDir, name), 'utf8')))
  if (focusResults.length !== 2) throw new Error('two-window test did not return two observations')
  if (!focusResults.every((result) => typeof result.focused === 'boolean')) {
    throw new Error('a disposable VS Code window returned an invalid focus observation')
  }
  if (focusResults.filter((result) => result.focused === true).length > 1) {
    throw new Error('two disposable VS Code windows simultaneously claimed focus')
  }
  if (readFileSync(marker, 'utf8') !== '') {
    throw new Error('extension-host matrix mutated the safety marker')
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 1,
        vscode: version,
        cases: ['same-window', 'multi-window', 'multi-root', 'worktree'],
        claudeProviderExtension: 'installed',
        missingNativeRecord: 'blocked-before-dispatch',
        codexClients: 2,
        codexMode: 'read-only-daemon-mirror',
        externalMutationMarker: 'unchanged',
      },
      null,
      2,
    )}\n`,
  )
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
