import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Codex hook, held to the same standard as the Claude one: the terminal must
 * never notice a problem, and the wire format must match what Codex actually
 * accepts — including the fields it FAILS CLOSED on.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '../hooks/longleash-codex-hook.mjs')

let dir: string
let server: Server | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'll-codex-hook-'))
})
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

function run(stdin: unknown, env: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, LONGLEASH_DATA: dir, HOME: dir, LONGLEASH_LOCAL_HANDOFF: 'off', ...env },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.on('close', (code) => done({ stdout, code }))
    child.stdin.write(JSON.stringify(stdin))
    child.stdin.end()
  })
}

async function listenOn(
  handler: (body: string, respond: (status: number, json: unknown) => void) => void,
): Promise<number> {
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
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const port = (server!.address() as { port: number }).port
  writeFileSync(
    join(dir, 'hook-endpoint.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret: 's3cret' }),
  )
  return port
}

/**
 * Exactly the fields Codex's `permission-request.command.input` schema declares —
 * notably WITHOUT `tool_use_id`, which only PreToolUse carries. An earlier version of
 * this fixture invented one, and the suite passed while the real thing sent no dedupe
 * key at all. Fixtures track the shipped schema, not what would be convenient.
 */
const permissionRequest = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PermissionRequest',
  session_id: 'sess-1',
  cwd: '/tmp/project',
  model: 'gpt-5.6',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  transcript_path: '/tmp/rollout.jsonl',
  turn_id: 'turn-1',
  ...over,
})

describe('the Codex hook — the terminal must never notice a problem', () => {
  it('says nothing and exits 0 when the daemon has never run', async () => {
    const { stdout, code } = await run(permissionRequest())
    expect(stdout).toBe('')
    expect(code).toBe(0)
  })

  it('says nothing and exits 0 when the daemon refuses the call', async () => {
    await listenOn((_b, respond) => respond(401, { reason: 'unauthorized' }))
    const { stdout, code } = await run(permissionRequest())
    expect(stdout).toBe('')
    expect(code).toBe(0)
  })

  it('says nothing and exits 0 on malformed stdin', async () => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, LONGLEASH_DATA: dir, HOME: dir },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    const code = await new Promise<number | null>((r) => {
      child.on('close', r)
      child.stdin.write('{not json')
      child.stdin.end()
    })
    expect(stdout).toBe('')
    expect(code).toBe(0)
  })

  it('does not mirror a LongLeash-managed app-server session as an external duplicate', async () => {
    let called = false
    await listenOn((_b, respond) => { called = true; respond(200, {}) })
    await run({ hook_event_name: 'SessionStart', session_id: 'managed' }, { LONGLEASH_MANAGED: '1' })
    expect(called).toBe(false)
  })

  it('stays silent when the daemon answers "ask" — the decision returns to Codex', async () => {
    await listenOn((_b, respond) => respond(200, { decision: 'ask', reason: 'nobody home' }))
    const { stdout } = await run(permissionRequest())
    expect(stdout).toBe('')
  })
})

describe('the Codex hook — the wire format Codex actually accepts', () => {
  it('an approval is spelled the way Codex requires', async () => {
    await listenOn((_b, respond) => respond(200, { decision: 'allow', reason: 'you said yes' }))
    const { stdout } = await run(permissionRequest())
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', message: 'you said yes' },
      },
    })
  })

  it('a denial carries the reason, which Codex requires to be non-empty', async () => {
    await listenOn((_b, respond) => respond(200, { decision: 'deny', reason: 'not that one' }))
    const out = JSON.parse((await run(permissionRequest())).stdout)
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(out.hookSpecificOutput.decision.message).toBe('not that one')
  })

  it('never emits the fields Codex FAILS CLOSED on', async () => {
    await listenOn((_b, respond) => respond(200, { decision: 'allow', reason: 'ok' }))
    const out = JSON.parse((await run(permissionRequest())).stdout)
    // Each of these voids the entire decision if present. Verified against the
    // binary's own validation messages.
    expect(out).not.toHaveProperty('continue')
    expect(out).not.toHaveProperty('stopReason')
    expect(out).not.toHaveProperty('suppressOutput')
    expect(out.hookSpecificOutput.decision).not.toHaveProperty('updatedInput')
    expect(out.hookSpecificOutput.decision).not.toHaveProperty('updatedPermissions')
    expect(out.hookSpecificOutput.decision).not.toHaveProperty('interrupt')
  })

  it('a missing reason still yields a non-empty message', async () => {
    await listenOn((_b, respond) => respond(200, { decision: 'deny' }))
    const out = JSON.parse((await run(permissionRequest())).stdout)
    expect(String(out.hookSpecificOutput.decision.message).length).toBeGreaterThan(0)
  })
})

describe('the Codex hook — what it tells the daemon', () => {
  it('names its vendor and derives a dedupe key from what PermissionRequest really carries', async () => {
    let body = ''
    await listenOn((b, respond) => {
      body = b
      respond(200, { decision: 'allow', reason: 'ok' })
    })
    await run(permissionRequest())
    const sent = JSON.parse(body)
    expect(sent.ll_agent).toBe('codex')
    expect(typeof sent.ll_dedupe).toBe('string')
    expect(sent.ll_dedupe.startsWith('turn-1:')).toBe(true)
    expect(sent.hook_event_name).toBe('PermissionRequest')
    expect(sent.tool_name).toBe('Bash')
    expect(sent.permission_mode).toBe('default')
  })

  it('the same call twice derives the SAME key; different calls derive different ones', async () => {
    const keyOf = async (event: unknown) => {
      let body = ''
      if (server) await new Promise<void>((r) => server!.close(() => r()))
      server = null
      await listenOn((b, respond) => {
        body = b
        respond(200, { decision: 'allow', reason: 'ok' })
      })
      await run(event)
      return JSON.parse(body).ll_dedupe as string
    }
    const a = await keyOf(permissionRequest())
    const again = await keyOf(permissionRequest())
    const otherArgs = await keyOf(permissionRequest({ tool_input: { command: 'ls' } }))
    const otherTurn = await keyOf(permissionRequest({ turn_id: 'turn-2' }))
    expect(again).toBe(a)
    // Colliding two genuinely different calls would silently apply one answer to
    // both — the one failure this key must never have.
    expect(otherArgs).not.toBe(a)
    expect(otherTurn).not.toBe(a)
  })

  it('uses tool_use_id when an event does carry one (PreToolUse-shaped payloads)', async () => {
    let body = ''
    await listenOn((b, respond) => {
      body = b
      respond(200, { decision: 'allow', reason: 'ok' })
    })
    await run(permissionRequest({ tool_use_id: 'exec-abc' }))
    expect(JSON.parse(body).ll_dedupe).toBe('exec-abc')
  })

  it('forwards SessionStart without waiting for a verdict', async () => {
    let body = ''
    await listenOn((b, respond) => {
      body = b
      respond(200, {})
    })
    const { stdout } = await run({
      hook_event_name: 'SessionStart',
      session_id: 'sess-2',
      cwd: '/tmp/project',
      source: 'startup',
      transcript_path: '/tmp/rollout.jsonl',
    })
    expect(JSON.parse(body).ll_agent).toBe('codex')
    expect(stdout).toBe('')
  })

  it('does NOT forward PreToolUse — PermissionRequest already carries the real decisions', async () => {
    let called = false
    await listenOn((_b, respond) => {
      called = true
      respond(200, {})
    })
    await run({ ...permissionRequest(), hook_event_name: 'PreToolUse' })
    expect(called).toBe(false)
  })

  it('a payload with nothing to key on still decides — dedupe is best-effort, never required', async () => {
    let body = ''
    await listenOn((b, respond) => {
      body = b
      respond(200, { decision: 'allow', reason: 'ok' })
    })
    const event = permissionRequest()
    delete (event as Record<string, unknown>).turn_id
    const { stdout } = await run(event)
    expect(JSON.parse(body)).not.toHaveProperty('ll_dedupe')
    // Losing dedupe must never cost the decision itself.
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('allow')
  })
})
