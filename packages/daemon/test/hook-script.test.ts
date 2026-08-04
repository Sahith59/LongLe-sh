import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function run(stdin: unknown): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, LONGLEASH_DATA: dir, HOME: dir },
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
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm build' },
    })
    expect(code).toBe(0)
    expect(secret).toBe('s3cret')
    expect(JSON.parse(received)).toMatchObject({ tool_name: 'Bash' })
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved from your phone by dev_x',
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
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Write',
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('read-only tools never even leave the machine', async () => {
    let called = false
    const port = await listenOn((_body, respond) => {
      called = true
      respond(200, {})
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    const { stdout, code } = await run({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(called).toBe(false)
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

  it('acceptEdits still gates a shell command — the terminal would have asked for that', async () => {
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
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
      permission_mode: 'acceptEdits',
    })
    expect(code).toBe(0)
    expect(called).toBe(true)
  })

  it("respects the person's own allowlist — what the terminal auto-runs never asks the phone", async () => {
    let called = false
    const port = await listenOn((_body, respond) => {
      called = true
      respond(200, { decision: 'ask', reason: 'x' })
    })
    writeFileSync(
      join(dir, 'hook-endpoint.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's' }),
    )
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm test:*)', 'WebFetch'] } }),
    )

    for (const payload of [
      { tool_name: 'Bash', tool_input: { command: 'pnpm test --run' } },
      { tool_name: 'WebFetch', tool_input: { url: 'https://x.dev' } },
    ]) {
      const { stdout, code } = await run({
        hook_event_name: 'PreToolUse',
        session_id: 'abc',
        ...payload,
      })
      expect(code).toBe(0)
      expect(stdout).toBe('')
    }
    expect(called).toBe(false)

    await run({
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    })
    expect(called).toBe(true)
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
