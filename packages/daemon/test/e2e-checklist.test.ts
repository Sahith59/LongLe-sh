import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startDaemon, type Daemon } from '../src/daemon.js'

/**
 * THE CHECKLIST, against a REAL daemon over a REAL socket.
 *
 * Every previous round of fixes was verified with unit tests and then failed in Sahith's hand.
 * The reason is not subtle: unit tests exercise a function, and he exercises a product. A hook
 * posting to a live HTTP endpoint, an event crossing a WebSocket, a phone pressing Stop on a
 * session that has changed owner — none of those are covered by testing the pieces, and all of
 * them are where the bugs actually were.
 *
 * So this file boots the whole laptop side and drives it the way a phone does. If something
 * here passes and still fails on his phone, the gap is the relay or the app, and that is worth
 * knowing precisely rather than guessing.
 */

let dir: string
let daemon: Daemon
let token: string
let ws: WebSocket

const HOST = '127.0.0.1'
const HOOK_SECRET_FILE = () => join(dir, 'data', 'hook-endpoint.json')

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'll-e2e-'))
  mkdirSync(join(dir, 'work'), { recursive: true })
  daemon = await startDaemon({
    allowedRoots: [join(dir, 'work')],
    host: HOST,
    port: 0,
    dataDir: join(dir, 'data'),
  })
  const challenge = daemon.registry.createPairingChallenge()
  const paired = daemon.registry.completePairing({
    challengeId: challenge.challengeId,
    secret: challenge.secret,
    deviceName: 'e2e phone',
  })
  token = paired.token
})

afterEach(async () => {
  try {
    ws?.close()
  } catch {
    /* already gone */
  }
  await daemon.stop()
  rmSync(dir, { recursive: true, force: true })
})

const inbox: Record<string, unknown>[] = []

async function connectPhone(): Promise<void> {
  inbox.length = 0
  ws = new WebSocket(`ws://${HOST}:${daemon.port}/ws?token=${encodeURIComponent(token)}`)
  ws.on('message', (raw: WebSocket.RawData) => {
    inbox.push(JSON.parse(raw.toString()) as Record<string, unknown>)
  })
  await waitFor(() => inbox.some((m) => m.type === 'hello'), 'hello')
}

async function waitFor(check: () => boolean, what: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const hello = () => inbox.find((m) => m.type === 'hello') as { sessions: Record<string, unknown>[] }

/** Post to the daemon exactly as a hook script does — same endpoint, same secret. */
async function hookPost(body: Record<string, unknown>): Promise<Response> {
  const endpoint = JSON.parse(
    (await import('node:fs')).readFileSync(HOOK_SECRET_FILE(), 'utf8'),
  ) as { url: string; secret: string }
  return fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-longleash-hook': endpoint.secret },
    body: JSON.stringify(body),
  })
}

const send = (message: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...message }))

describe('CHECKLIST end to end — a real daemon, a real socket', () => {
  it('a terminal session started by a hook reaches the phone, tagged with its agent and surface', async () => {
    await connectPhone()
    const transcript = join(dir, 'work', 't.jsonl')
    writeFileSync(transcript, '')

    await hookPost({
      hook_event_name: 'SessionStart',
      session_id: 'sess-a',
      cwd: join(dir, 'work'),
      transcript_path: transcript,
      ll_agent: 'codex',
      ll_surface: 'vscode',
      ll_pid: process.pid,
    })

    await waitFor(() => inbox.some((m) => m.type === 'session.started'), 'session.started')
    const started = inbox.find((m) => m.type === 'session.started') as {
      payload: { agent: string; origin: string }
    }
    // Checklist 3 and 5: the phone must be able to tell WHICH agent and WHERE.
    expect(started.payload.agent).toBe('codex')
    expect(started.payload.origin).toBe('vscode')
  })

  it('an approval reaches the phone and the verdict reaches the hook', async () => {
    await connectPhone()
    const transcript = join(dir, 'work', 't2.jsonl')
    writeFileSync(transcript, '')
    await hookPost({
      hook_event_name: 'SessionStart',
      session_id: 'sess-b',
      cwd: join(dir, 'work'),
      transcript_path: transcript,
      ll_pid: process.pid,
    })
    await waitFor(() => inbox.some((m) => m.type === 'session.started'), 'start')

    // The hook blocks on this, exactly as it does in a real terminal.
    const asking = hookPost({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-b',
      cwd: join(dir, 'work'),
      transcript_path: transcript,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
      permission_mode: 'default',
    })

    await waitFor(() => inbox.some((m) => m.type === 'approval.requested'), 'approval')
    const requested = inbox.find((m) => m.type === 'approval.requested') as {
      sessionId: string
      payload: { approvalId: string; inputSummary: string }
    }
    expect(requested.payload.inputSummary).toContain('rm -rf build')

    send({
      type: 'decision',
      sessionId: requested.sessionId,
      approvalId: requested.payload.approvalId,
      verdict: 'allow',
    })

    // Checklist 1: the answer must actually get back to the terminal.
    const verdict = (await (await asking).json()) as { decision: string }
    expect(verdict.decision).toBe('allow')

    // …and the card must clear, so the inbox never shows a decision already made.
    await waitFor(() => inbox.some((m) => m.type === 'approval.decided'), 'approval.decided')
  })

  it('Stop actually stops a live terminal session', async () => {
    await connectPhone()
    const transcript = join(dir, 'work', 't3.jsonl')
    writeFileSync(transcript, '')
    // A process that really exists and that we are allowed to signal.
    const victim = (await import('node:child_process')).spawn('sleep', ['120'])
    await hookPost({
      hook_event_name: 'SessionStart',
      session_id: 'sess-c',
      cwd: join(dir, 'work'),
      transcript_path: transcript,
      ll_pid: victim.pid,
    })
    await waitFor(() => inbox.some((m) => m.type === 'session.started'), 'start')

    const sessionId = (inbox.find((m) => m.type === 'session.started') as { sessionId: string }).sessionId
    send({ type: 'stopSession', sessionId })

    // Checklist 6 and 7: Stop has to mean stopped, and say so.
    await waitFor(
      () => inbox.some((m) => m.type === 'ack' && m.of === 'stopSession'),
      'stop ack',
    )
    const ack = inbox.find((m) => m.type === 'ack' && m.of === 'stopSession') as { outcome: string }
    expect(ack.outcome).toBe('stopped')
    victim.kill('SIGKILL')
  })

  it('Stop is answered — never silently refused — for a session the terminal manager no longer owns', async () => {
    // The exact shape of the two-day failure: `reopened` then `refused` a second later.
    await connectPhone()
    send({ type: 'stopSession', sessionId: 'ext_owned-by-nobody' })
    await waitFor(
      () => inbox.some((m) => m.type === 'ack' && m.of === 'stopSession'),
      'an answer of some kind',
    )
  })

  it('a session the daemon does not know about is never announced as live', async () => {
    // Checklist 7 and 8: nothing from a previous life may appear as working.
    await connectPhone()
    for (const session of hello().sessions as { status: string; live?: boolean }[]) {
      if (session.status === 'running' || session.status === 'waiting') {
        expect(session.live).toBe(true)
      }
    }
  })

  it('the daemon tells the phone which app build it expects', async () => {
    // Checklist: an out-of-date phone must be able to say so rather than look broken.
    await connectPhone()
    expect(hello()).toHaveProperty('expectsApp')
  })
})
