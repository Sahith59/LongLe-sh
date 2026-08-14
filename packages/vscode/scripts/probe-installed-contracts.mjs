import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Read-only V0 capability probe. It starts no agent, opens no editor window, reads no transcript,
 * and emits no workspace path. Codex's own schema generator writes only beneath the disposable
 * directory created here, which is removed in finally.
 */
function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim()
  } catch {
    throw new Error(`${command} capability probe failed`)
  }
}

function extensionVersion(list, id) {
  const prefix = `${id}@`
  const match = list
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix))
  return match?.slice(prefix.length)
}

const generated = mkdtempSync(join(tmpdir(), 'longleash-v0-'))
try {
  const codeOutput = run('code', ['--version']).split(/\r?\n/u)
  const extensions = run('code', ['--list-extensions', '--show-versions'])
  const claudeCli = run('claude', ['--version'])
  const codexCli = run('codex', ['--version'])

  run('codex', ['app-server', 'generate-ts', '--out', generated])
  const requests = readFileSync(join(generated, 'ClientRequest.ts'), 'utf8')
  const threadStatus = readFileSync(join(generated, 'v2', 'ThreadStatus.ts'), 'utf8')
  const codexMethods = {
    initialize: requests.includes('"method": "initialize"'),
    threadRead: requests.includes('"method": "thread/read"'),
    threadResume: requests.includes('"method": "thread/resume"'),
    turnStart: requests.includes('"method": "turn/start"'),
    readStatus:
      threadStatus.includes('"type": "notLoaded"') &&
      threadStatus.includes('"type": "idle"') &&
      threadStatus.includes('"type": "active"') &&
      threadStatus.includes('"type": "systemError"'),
  }
  if (Object.values(codexMethods).some((present) => !present)) {
    throw new Error('codex app-server is missing a required V0 method')
  }

  const report = {
    schema: 1,
    vscode: codeOutput[0] ?? 'unknown',
    claudeExtension: extensionVersion(extensions, 'anthropic.claude-code') ?? 'missing',
    codexExtension: extensionVersion(extensions, 'openai.chatgpt') ?? 'missing',
    claudeCli: /^\d+\.\d+\.\d+/u.exec(claudeCli)?.[0] ?? 'unknown',
    codexCli: /\d+\.\d+\.\d+/u.exec(codexCli)?.[0] ?? 'unknown',
    codexMethods,
    sideEffects: 'no-agent-no-editor-no-transcript',
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  rmSync(generated, { recursive: true, force: true })
}
