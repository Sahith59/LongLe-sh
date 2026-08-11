import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../../src/eventlog.js'
import { ApprovalStore } from '../../src/approvals.js'
import { SessionManager } from '../../src/sessions.js'
import { createClaudeAgentFactory } from '../../src/adapters/claude.js'

/**
 * Contract tests run REAL Claude through the adapter. They are excluded from the normal
 * suite and from CI (no auth there) — run them deliberately:
 *
 *   pnpm test:contract
 *
 * They use the Claude Code CLI's subscription OAuth, not an API key (spike S0), so they
 * consume plan allowance rather than money. Keep them few.
 */
const ENABLED = process.env.LONGLEASH_CONTRACT === '1'
const suite = ENABLED ? describe : describe.skip

interface Ctx {
  manager: SessionManager
  log: EventLog
  approvals: ApprovalStore
  root: string
}

function setup(opts: { allowedTools?: string[] } = {}): Ctx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-contract-')))
  const log = new EventLog(':memory:')
  const approvals = new ApprovalStore(':memory:')
  const manager = new SessionManager({
    eventLog: log,
    approvals,
    allowedRoots: [root],
    agentFactories: {
      claude: createClaudeAgentFactory({
        maxTurns: 6,
        // Nothing is pre-approved and machine settings are ignored, so every tool must come
        // through our approval path. Without this the suite depends on whatever the developer's
        // Claude Code settings allow, and approvals appear or vanish between machines.
        allowedTools: opts.allowedTools ?? [],
        isolateFromUserSettings: true,
      }),
    },
    ...(process.env.LONGLEASH_DEBUG === '1'
      ? {
          onEvent: (e) =>
            // eslint-disable-next-line no-console
            console.log(`  [${e.seq}] ${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`),
        }
      : {}),
  })
  return { manager, log, approvals, root }
}

async function teardown(ctx: Ctx): Promise<void> {
  // Agents first: a consume loop still writing into a closed database throws from nowhere.
  await ctx.manager.shutdown()
  rmSync(ctx.root, { recursive: true, force: true })
  ctx.log.close()
  ctx.approvals.close()
}

const statusOf = (ctx: Ctx, sessionId: string) =>
  ctx.manager.listSessions().find((s) => s.sessionId === sessionId)?.status

/**
 * A conversation does not end when the agent stops talking — it hands control back and waits
 * for you. `waitForIdle` waits for the agent's stream to CLOSE, which now only happens on
 * stop; waiting for that here is what made every one of these tests hang after the product
 * moved from one-shot runs to conversations.
 */
const untilTurnEnds = (ctx: Ctx, sessionId: string) =>
  until(() => ['waiting', 'ended', 'errored'].includes(statusOf(ctx, sessionId) ?? ''))

const eventsOf = (ctx: Ctx, sessionId: string) => {
  const replay = ctx.log.replay(sessionId, 0)
  if (replay.gap) throw new Error('unexpected gap')
  return replay.events
}

const textOf = (ctx: Ctx, sessionId: string) =>
  eventsOf(ctx, sessionId)
    .filter((e) => e.type === 'stream.delta')
    .map((e) => (e.payload as { text: string }).text)
    .join('')

/** Poll until a condition holds, so tests never depend on fixed sleeps. */
async function until(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Surface the agent's own failure rather than a downstream "file missing" mystery. */
function expectSessionSucceeded(ctx: Ctx, sessionId: string): void {
  const errored = eventsOf(ctx, sessionId).find((e) => e.type === 'session.errored')
  if (errored) {
    throw new Error(`session errored: ${(errored.payload as { message: string }).message}`)
  }
}

/** Wait for a side effect to land; the stream can end microseconds before the write settles. */
async function untilFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/**
 * Stands in for a human with the app open: answers every approval as it arrives. Real Claude
 * often needs several in one task, and answering only the first would park the session forever.
 */
function autoRespond(ctx: Ctx, verdict: 'allow' | 'deny', reply?: string): () => void {
  const timer = setInterval(() => {
    for (const approval of ctx.manager.listPendingApprovals()) {
      ctx.manager.decide(approval.approvalId, verdict, 'contract-test', reply)
    }
  }, 200)
  return () => clearInterval(timer)
}

suite('contract: real Claude through the adapter', () => {
  let ctx: Ctx
  beforeEach(() => {
    ctx = setup()
  })
  afterEach(async () => teardown(ctx))

  it('runs a real session end to end and streams text back', async () => {
    const { sessionId } = await ctx.manager.startSession({
      agent: 'claude',
      cwd: ctx.root,
      prompt: 'Reply with exactly the word LEASH and nothing else. Do not use any tools.',
    })
    await untilTurnEnds(ctx, sessionId)

    const types = eventsOf(ctx, sessionId).map((e) => e.type)
    expect(types[0]).toBe('session.started')
    expect(types).toContain('stream.delta')
    expect(textOf(ctx, sessionId)).toContain('LEASH')
    // The turn ended, but the conversation stays open for a reply — that is the product.
    expect(statusOf(ctx, sessionId)).toBe('waiting')

    // And stopping it really does close it.
    expect(await ctx.manager.stopSession(sessionId, 'contract-test')).toBe(true)
    expect(eventsOf(ctx, sessionId).map((e) => e.type)).toContain('session.ended')
  }, 180_000)

  it('blocks on approval, and ALLOW lets the real tool actually run', async () => {
    const { sessionId } = await ctx.manager.startSession({
      agent: 'claude',
      cwd: ctx.root,
      prompt: `Create the file ${join(ctx.root, 'approved.txt')} containing the word YES. Then reply DONE.`,
    })

    await until(() => ctx.manager.listPendingApprovals().some((a) => a.toolName === 'Write'))
    const approval = ctx.manager.listPendingApprovals().find((a) => a.toolName === 'Write')!
    expect(approval.sessionId).toBe(sessionId)

    // The exact path the human is being asked to approve — agents do not always target the
    // session directory, so assert against what was actually shown rather than a guess.
    const targetPath = approval.inputSummary.replace(/^Write\s+/, '')
    expect(targetPath.startsWith('/')).toBe(true)

    // The real agent is genuinely parked while we hold the decision.
    expect(existsSync(targetPath)).toBe(false)
    await new Promise((r) => setTimeout(r, 1500))
    expect(existsSync(targetPath)).toBe(false)

    const stop = autoRespond(ctx, 'allow')
    await untilTurnEnds(ctx, sessionId)
    stop()
    expectSessionSucceeded(ctx, sessionId)

    // Assert on the side effect, never the agent's own words (spike S0 rule).
    expect(await untilFile(targetPath)).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toContain('YES')
  }, 180_000)

  it('DENY prevents the tool from ever running and delivers the steering reply', async () => {
    const { sessionId } = await ctx.manager.startSession({
      agent: 'claude',
      cwd: ctx.root,
      prompt: `Create the file ${join(ctx.root, 'denied.txt')} containing NO. If you cannot, explain briefly.`,
    })

    const stop = autoRespond(ctx, 'deny', 'Do not create any files.')
    await untilTurnEnds(ctx, sessionId)
    stop()

    expect(existsSync(join(ctx.root, 'denied.txt'))).toBe(false)
    const decided = eventsOf(ctx, sessionId).find((e) => e.type === 'approval.decided')
    expect(decided?.payload).toMatchObject({ verdict: 'deny' })
  }, 180_000)

  it('pins cwd: the agent actually runs inside the session directory', async () => {
    // Ask the agent to report its own working directory rather than inferring it from a file
    // it may or may not choose to create — spike S0 showed an agent writing outside its cwd,
    // so this asserts the invariant directly and deterministically.
    const strayInHome = join(homedir(), 'longleash_cwd_probe.txt')
    rmSync(strayInHome, { force: true })

    const { sessionId } = await ctx.manager.startSession({
      agent: 'claude',
      cwd: ctx.root,
      prompt: 'Run the pwd command and reply with ONLY the absolute path it printed.',
    })
    const stop = autoRespond(ctx, 'allow')
    await untilTurnEnds(ctx, sessionId)
    stop()
    expectSessionSucceeded(ctx, sessionId)

    expect(textOf(ctx, sessionId)).toContain(ctx.root)
    expect(existsSync(strayInHome)).toBe(false)
  }, 180_000)

  it('surfaces auto-approved tools in the activity feed', async () => {
    // This needs a harness that actually pre-approves something: with nothing allowed, every
    // tool goes through the approval path and there is no auto-approval left to observe.
    // These are the daemon's production defaults — read-only tools run, everything else asks.
    const readOnly = setup({ allowedTools: ['Read', 'Glob', 'Grep'] })
    try {
      const { sessionId } = await readOnly.manager.startSession({
        agent: 'claude',
        cwd: readOnly.root,
        prompt: 'List the files in the current directory using a tool, then reply DONE.',
      })
      const stop = autoRespond(readOnly, 'allow') // anything beyond read-only still asks
      await untilTurnEnds(readOnly, sessionId)
      stop()

      const activity = eventsOf(readOnly, sessionId).filter((e) => e.type === 'activity.tool')
      expect(activity.length).toBeGreaterThan(0)
      expect(activity[0]?.payload).toMatchObject({ autoApproved: true })
    } finally {
      await teardown(readOnly)
    }
  }, 180_000)

  it('writes a session transcript the Claude CLI can resume from the same directory', async () => {
    const { sessionId } = await ctx.manager.startSession({
      agent: 'claude',
      cwd: ctx.root,
      prompt: 'Reply with the word MARK and nothing else. Do not use any tools.',
    })
    await untilTurnEnds(ctx, sessionId)

    // Claude stores transcripts under ~/.claude/projects/<encoded-cwd>/
    const projectsDir = join(homedir(), '.claude', 'projects')
    const encoded = ctx.root.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(projectsDir, encoded)
    expect(existsSync(dir)).toBe(true)
    const transcripts = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(transcripts.length).toBeGreaterThan(0)
  }, 180_000)
})
