import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog, coalesceTextDeltas, type AppendInput } from '../src/eventlog.js'

const delta = (text: string): AppendInput => ({
  type: 'stream.delta',
  payload: { kind: 'text', text },
})

const started: AppendInput = {
  type: 'session.started',
  payload: { agent: 'claude', cwd: '/tmp/proj' },
}

describe('EventLog: append + replay', () => {
  let log: EventLog

  beforeEach(() => {
    log = new EventLog(':memory:')
  })
  afterEach(() => log.close())

  it('assigns monotonic 1-based seq per session', () => {
    const a = log.append('ses_a', started)
    const b = log.append('ses_a', delta('one'))
    const c = log.append('ses_a', delta('two'))
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
  })

  it('stamps events with the injected clock', () => {
    const clocked = new EventLog(':memory:', { now: () => 1753900000000 })
    const ev = clocked.append('ses_a', started)
    expect(ev.ts).toBe(1753900000000)
    clocked.close()
  })

  it('rejects an event that violates the protocol and persists nothing', () => {
    expect(() =>
      log.append('ses_a', { type: 'stream.delta', payload: { kind: 'text' } } as never),
    ).toThrowError()
    const replay = log.replay('ses_a', 0)
    expect(replay.gap).toBe(false)
    if (!replay.gap) expect(replay.events).toHaveLength(0)
  })

  it('replays all events in order from cursor 0', () => {
    log.append('ses_a', started)
    log.append('ses_a', delta('one'))
    log.append('ses_a', delta('two'))
    const replay = log.replay('ses_a', 0)
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(replay.events[0]?.type).toBe('session.started')
  })

  it('replays only events newer than the cursor', () => {
    log.append('ses_a', started)
    log.append('ses_a', delta('one'))
    log.append('ses_a', delta('two'))
    const replay = log.replay('ses_a', 2)
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events.map((e) => e.seq)).toEqual([3])
  })

  it('replay at the latest cursor is empty, not a gap', () => {
    log.append('ses_a', started)
    const replay = log.replay('ses_a', 1)
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events).toHaveLength(0)
  })

  it('signals an explicit gap when the cursor is ahead of the log (client must reset)', () => {
    log.append('ses_a', started)
    const replay = log.replay('ses_a', 99)
    if (!replay.gap) expect.unreachable('gap expected')
    expect(replay.reason).toBe('cursor-ahead')
    expect(replay.latestSeq).toBe(1)
  })

  it('keeps per-session order and independent seqs under interleaved appends', () => {
    log.append('ses_a', started)
    log.append('ses_b', started)
    log.append('ses_a', delta('a1'))
    log.append('ses_b', delta('b1'))
    log.append('ses_a', delta('a2'))
    const a = log.replay('ses_a', 0)
    const b = log.replay('ses_b', 0)
    if (a.gap || b.gap) expect.unreachable('no gap expected')
    expect(a.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(b.events.map((e) => e.seq)).toEqual([1, 2])
    expect(a.events.every((e) => e.sessionId === 'ses_a')).toBe(true)
  })
})

describe('EventLog: batches are atomic', () => {
  it('appendBatch commits all events in one transaction with consecutive seqs', () => {
    const log = new EventLog(':memory:')
    const events = log.appendBatch('ses_a', [started, delta('one'), delta('two')])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    log.close()
  })

  it('an invalid event mid-batch persists NOTHING', () => {
    const log = new EventLog(':memory:')
    expect(() =>
      log.appendBatch('ses_a', [
        started,
        { type: 'not.a.real.event', payload: {} } as never,
        delta('never lands'),
      ]),
    ).toThrowError()
    const replay = log.replay('ses_a', 0)
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events).toHaveLength(0)
    log.close()
  })
})

describe('EventLog: retention + gap on pruned history', () => {
  it('pruneBefore removes old events and replay from pruned cursor signals a gap with earliestSeq', () => {
    const log = new EventLog(':memory:')
    for (let i = 0; i < 10; i++) log.append('ses_a', delta(`d${i}`))
    log.pruneBefore('ses_a', 6)
    const stale = log.replay('ses_a', 2)
    if (!stale.gap) expect.unreachable('gap expected')
    expect(stale.reason).toBe('pruned')
    expect(stale.earliestSeq).toBe(6)
    const fresh = log.replay('ses_a', 6)
    if (fresh.gap) expect.unreachable('no gap expected')
    expect(fresh.events.map((e) => e.seq)).toEqual([7, 8, 9, 10])
    log.close()
  })
})

describe('EventLog: durability across restart', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'longleash-eventlog-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reopening the same file sees every committed event', () => {
    const dbPath = join(dir, 'events.db')
    const first = new EventLog(dbPath)
    first.append('ses_a', started)
    first.append('ses_a', delta('one'))
    first.close()

    const second = new EventLog(dbPath)
    const replay = second.replay('ses_a', 0)
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events.map((e) => e.seq)).toEqual([1, 2])
    second.close()
  })

  it('never reuses a seq after restart', () => {
    const dbPath = join(dir, 'events.db')
    const first = new EventLog(dbPath)
    first.append('ses_a', started)
    first.append('ses_a', delta('one'))
    first.close()

    const second = new EventLog(dbPath)
    const ev = second.append('ses_a', delta('after restart'))
    expect(ev.seq).toBe(3)
    second.close()
  })

  it('persists a user-owned session alias across daemon restarts', () => {
    const dbPath = join(dir, 'events.db')
    const first = new EventLog(dbPath)
    first.setAlias('ses_a', 'Release audit')
    first.close()

    const second = new EventLog(dbPath)
    expect(second.aliasFor('ses_a')).toBe('Release audit')
    expect(second.aliasFor('ses_missing')).toBeUndefined()
    second.close()
  })

  it('rejects tampered rows on replay instead of returning garbage', () => {
    const dbPath = join(dir, 'events.db')
    const log = new EventLog(dbPath)
    log.append('ses_a', started)
    log.close()

    const tamper = new EventLog(dbPath)
    tamper.rawDb.prepare("UPDATE events SET payload = '{\"broken\": true}'").run()
    expect(() => tamper.replay('ses_a', 0)).toThrowError()
    tamper.close()
  })
})

describe('EventLog: performance bound', () => {
  it('replays 10k events in under 1 second', () => {
    const log = new EventLog(':memory:')
    const batch: AppendInput[] = Array.from({ length: 10_000 }, (_, i) => delta(`line ${i}`))
    log.appendBatch('ses_perf', batch)
    const t0 = performance.now()
    const replay = log.replay('ses_perf', 0)
    const elapsed = performance.now() - t0
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events).toHaveLength(10_000)
    expect(elapsed).toBeLessThan(1000)
    log.close()
  })
})

describe('coalesceTextDeltas', () => {
  it('merges consecutive text deltas into one', () => {
    const out = coalesceTextDeltas([delta('a'), delta('b'), delta('c')])
    expect(out).toHaveLength(1)
    expect(out[0]?.payload).toMatchObject({ kind: 'text', text: 'abc' })
  })

  it('does not merge across non-text boundaries', () => {
    const tool: AppendInput = { type: 'stream.delta', payload: { kind: 'tool', text: '[Bash]' } }
    const out = coalesceTextDeltas([delta('a'), tool, delta('b'), delta('c')])
    expect(out).toHaveLength(3)
    expect(out[2]?.payload).toMatchObject({ text: 'bc' })
  })

  it('leaves non-delta events untouched and in place', () => {
    const out = coalesceTextDeltas([started, delta('a'), delta('b')])
    expect(out).toHaveLength(2)
    expect(out[0]?.type).toBe('session.started')
  })
})
