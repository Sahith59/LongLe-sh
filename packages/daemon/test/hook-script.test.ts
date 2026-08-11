import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '../hooks/longleash-hook.mjs')

let dir: string
let server: Server | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'll-hook-'))
})
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

function run(
  stdin: unknown,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, LONGLEASH_DATA: dir, HOME: dir, LONGLEASH_LOCAL_HANDOFF: 'off', ...env },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('close', (code) => resolvePromise({ stdout, code }))
    child.stdin.write(JSON.stringify(stdin))
    child.stdin.end()
  })
}

async function listenOn(handler: (body: string, respond: (status: number, json: unknown) => void) => void): Promise<number> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () =>
      handler(body, (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      }),
    )
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const address = server!.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

describe('the hook script — the terminal must never notice a problem', () => {
  it('relays an allow verdict as a Claude Code permission decision', async () => {
    let received = ''
    let secret = ''
    const port = await listenOn((body, respond) => {
      received = body
      respond(200, { decision: 'allow', reason: 'Approved from your phone by dev_x' })
    })
    server!.on('request', (req) => {
      secret = String(req.headers['x-longleash-hook'] ?? '')
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's3cret' }),
    )

    const { stdout, code } = await run({
      hook_event_name: 'PermissionRequest',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm build' },
    })
    expect(code).toBe(0)
    expect(secret).toBe('s3cret')
    expect(JSON.parse(received)).toMatchObject({ tool_name: 'Bash' })
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
        },
      },
    })
  })

  it('an "ask" verdict stays silent, handing the decision back to the terminal', async () => {
    const port = await listenOn((_body, respond) =>
      respond(200, { decision: 'ask', reason: 'nobody answered' }),
    )
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    const { stdout, code } = await run({
      hook_event_name: 'PermissionRequest',
      session_id: 'abc',
      tool_name: 'Write',
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('an async PreToolUse observer reports activity without making a decision', async () => {
    let called = false
    let body = ''
    const observerPort = await listenOn((received, respond) => {
      called = true
      body = received
      respond(200, {})
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${observerPort}/hook`, secret: 's' }),
    )
    const { stdout, code } = await run({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    }, ['--observe'])
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(called).toBe(true)
    expect(JSON.parse(body).hook_event_name).toBe('SessionObserved')
  })

  it('mirrors the permission mode: an auto-approving session never reaches the daemon', async () => {
    let called = false
    const port = await listenOn((_body, respond) => {
      called = true
      respond(200, {})
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    for (const [mode, tool] of [
      ['bypassPermissions', 'Bash'],
      // 'auto' is what VS Code's chat actually reports — the value that was missed, and
      // that paged a phone about every command an auto-approving session ran.
      ['auto', 'Bash'],
      ['auto', 'Write'],
      // Any mode this hook has never heard of decides for itself; staying silent hands
      // the decision to the terminal, which is safe by construction.
      ['someFutureMode', 'Bash'],
      ['plan', 'Bash'],
      ['acceptEdits', 'Edit'],
      ['acceptEdits', 'Write'],
    ]) {
      const { stdout, code } = await run({
        hook_event_name: 'PreToolUse',
        session_id: 'abc',
        tool_name: tool,
        permission_mode: mode,
      })
      expect(code).toBe(0)
      expect(stdout).toBe('')
    }
    expect(called).toBe(false)
  })

  it('PermissionRequest is authoritative regardless of permission mode', async () => {
    let called = false
    const port = await listenOn((_body, respond) => {
      called = true
      respond(200, { decision: 'ask', reason: 'x' })
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    const { code } = await run({
      hook_event_name: 'PermissionRequest',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
      permission_mode: 'acceptEdits',
    })
    expect(code).toBe(0)
    expect(called).toBe(true)
  })

  it('ordinary PreToolUse never creates a permission request', async () => {
    let called = false
    const port = await listenOn((_body, respond) => {
      called = true
      respond(200, { decision: 'ask', reason: 'x' })
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    const result = await run({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    })
    expect(result.stdout).toBe('')
    expect(called).toBe(false)
  })

  it('does not mirror a LongLeash-managed SDK session as an external duplicate', async () => {
    let called = false
    const port = await listenOn((_body, respond) => { called = true; respond(200, {}) })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    await run({ hook_event_name: 'SessionStart', session_id: 'managed' }, [], { LONGLEASH_MANAGED: '1' })
    expect(called).toBe(false)
  })

  it('a QUESTION always reaches the phone, in every permission mode', async () => {
    // Claude Code shows its question dialog regardless of permission mode — it is asking
    // the human to choose, not asking to be allowed. An auto-mode session that skipped
    // this asked its questions to an empty room.
    let seen = 0
    const port = await listenOn((_body, respond) => {
      seen += 1
      respond(200, { decision: 'ask', reason: 'x' })
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    for (const mode of ['bypassPermissions', 'acceptEdits', 'plan', 'default']) {
      await run({
        hook_event_name: 'PreToolUse',
        session_id: 'abc',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which?', header: 'Pick', options: [] }] },
        permission_mode: mode,
      })
    }
    expect(seen).toBe(4)
  })

  it('returns phone answers as native AskUserQuestion input', async () => {
    const port = await listenOn((_body, respond) => respond(200, {
      decision: 'allow',
      reason: 'Answered from your phone.',
      answers: { 'Which one?': 'Codex' },
      additionalContext: 'The user added: use the fast path',
    }))
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    const out = JSON.parse((await run({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which one?', header: 'Agent', options: [] }] },
    })).stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(out.hookSpecificOutput.updatedInput.answers).toEqual({ 'Which one?': 'Codex' })
    expect(out.hookSpecificOutput.updatedInput.questions).toHaveLength(1)
    expect(out.hookSpecificOutput.additionalContext).toBe('The user added: use the fast path')
  })

  it('with no daemon endpoint at all, it exits clean and silent', async () => {
    const { stdout, code } = await run({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('with the daemon down, it exits clean and silent', async () => {
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: 'http://127.0.0.1:1/hook', secret: 's' }),
    )
    const { stdout, code } = await run({
      hook_event_name: 'SessionStart',
      session_id: 'abc',
      cwd: '/x',
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('garbage on stdin cannot make it misbehave', async () => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, LONGLEASH_DATA: dir, HOME: dir } })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    const code = await new Promise<number | null>((r) => {
      child.on('close', r)
      child.stdin.write('}{ not json at all')
      child.stdin.end()
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })
})
