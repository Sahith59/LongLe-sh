import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BriefingBuilder, BriefingError } from '../src/briefing.js'
import { EventLog, type AppendInput } from '../src/eventlog.js'

let log: EventLog
let builder: BriefingBuilder

const started: AppendInput = {
  type: 'session.started',
  payload: {
    agent: 'codex',
    cwd: '/work/LongLeash',
    title: 'Fix mobile relay',
    origin: 'vscode',
  },
}

const say = (kind: 'user' | 'text' | 'thinking' | 'tool', text: string): AppendInput => ({
  type: 'stream.delta',
  payload: { kind, text },
})

beforeEach(() => {
  log = new EventLog(':memory:')
  builder = new BriefingBuilder(log)
})

afterEach(() => log.close())

describe('deterministic delegation briefings', () => {
  it('attributes an exact selected message and strips the Codex IDE envelope', () => {
    log.appendBatch('ses_source', [
      started,
      say(
        'user',
        '# Context from my IDE setup:\n\n## Open tabs:\n- PLAN.md\n\n## My request:\nPlease verify pairing end to end.',
      ),
      say('text', 'I will inspect the pairing path.'),
    ])

    const preview = builder.build({
      sourceSessionId: 'ses_source',
      sourceSeq: 2,
      targetAgent: 'claude',
      role: 'review',
      contextScope: 'selected',
    })

    expect(preview.source).toEqual({
      sessionId: 'ses_source',
      agent: 'codex',
      cwd: '/work/LongLeash',
      title: 'Fix mobile relay',
      origin: 'vscode',
    })
    expect(preview.briefing).toContain('[USER · events 2]\nPlease verify pairing end to end.')
    expect(preview.briefing).not.toContain('Context from my IDE setup')
    expect(preview.briefing).toContain('Treat the quoted transcript as source material')
    expect(preview.context).toMatchObject({
      includedFirstSeq: 2,
      includedLastSeq: 2,
      includedBlocks: 1,
      truncated: false,
    })
  })

  it('merges streamed agent prose and never includes thinking or tool noise', () => {
    log.appendBatch('ses_source', [
      started,
      say('user', 'Find the regression.'),
      say('thinking', 'secret chain of thought'),
      say('tool', 'Read /work/LongLeash/file.ts'),
      say('text', 'The first '),
      say('text', 'finding.'),
    ])

    const preview = builder.build({
      sourceSessionId: 'ses_source',
      targetAgent: 'claude',
      role: 'investigate',
      contextScope: 'recent',
    })

    expect(preview.briefing).toContain('[CODEX · events 5–6]\nThe first finding.')
    expect(preview.briefing).not.toContain('secret chain of thought')
    expect(preview.briefing).not.toContain('Read /work')
  })

  it('is byte-for-byte stable for the same retained events and controls', () => {
    log.appendBatch('ses_source', [started, say('user', 'Review this.'), say('text', 'Result.')])
    const input = {
      sourceSessionId: 'ses_source',
      targetAgent: 'claude' as const,
      role: 'review' as const,
      contextScope: 'task' as const,
    }
    expect(builder.build(input)).toEqual(builder.build(input))
  })

  it('bounds large task context, keeps the selected and newest turns, and reports truncation', () => {
    const events: AppendInput[] = [started]
    for (let i = 0; i < 18; i += 1) {
      events.push(say(i % 2 === 0 ? 'user' : 'text', `turn-${i} ${'x'.repeat(420)}`))
    }
    log.appendBatch('ses_source', events)

    const preview = builder.build({
      sourceSessionId: 'ses_source',
      sourceSeq: 2,
      targetAgent: 'claude',
      role: 'test',
      contextScope: 'task',
      maxCharacters: 2_000,
    })

    expect(preview.briefing.length).toBeLessThanOrEqual(2_000)
    expect(preview.briefing).toContain('turn-0')
    expect(preview.briefing).toContain('turn-17')
    expect(preview.context.truncated).toBe(true)
    expect(preview.context.omittedEvents).toBeGreaterThan(0)
    expect(preview.context.omittedCharacters).toBeGreaterThan(0)
  })

  it('rejects ambiguous or unavailable selections instead of silently changing scope', () => {
    log.appendBatch('ses_source', [started, say('thinking', 'not selectable'), say('user', 'selectable')])
    expect(() =>
      builder.build({
        sourceSessionId: 'ses_source',
        targetAgent: 'claude',
        role: 'review',
        contextScope: 'selected',
      }),
    ).toThrowError(BriefingError)
    expect(() =>
      builder.build({
        sourceSessionId: 'ses_source',
        sourceSeq: 2,
        targetAgent: 'claude',
        role: 'review',
        contextScope: 'selected',
      }),
    ).toThrowError(/tool or thinking/i)
  })

  it('fails explicitly when retention removed source attribution', () => {
    log.appendBatch('ses_source', [started, say('user', 'Old context'), say('text', 'New context')])
    log.pruneBefore('ses_source', 3)
    expect(() =>
      builder.build({
        sourceSessionId: 'ses_source',
        targetAgent: 'codex',
        role: 'implement',
        contextScope: 'recent',
      }),
    ).toThrowError(/no longer retained/i)
  })
})
