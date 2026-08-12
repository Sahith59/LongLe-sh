import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_DELEGATION_RETURN_CHARACTERS } from '@longleash/protocol'
import { EventLog } from '../src/eventlog.js'
import { ReturnBuilder, ReturnBuilderError } from '../src/return-builder.js'

let log: EventLog
let builder: ReturnBuilder

beforeEach(() => {
  log = new EventLog(':memory:')
  builder = new ReturnBuilder(log)
})

afterEach(() => log.close())

function start(sessionId = 'ses_child'): void {
  log.append(sessionId, {
    type: 'session.started',
    payload: { agent: 'codex', cwd: '/tmp/project', title: 'Review · parser', origin: 'phone' },
  })
}

describe('reviewed return selection', () => {
  it('uses only the last completed prose turn and excludes thinking, tools, and partial text', () => {
    start()
    log.appendBatch('ses_child', [
      { type: 'stream.delta', payload: { kind: 'user', text: '\n› review this\n' } },
      { type: 'stream.delta', payload: { kind: 'thinking', text: 'private chain' } },
      { type: 'stream.delta', payload: { kind: 'tool', text: 'Read parser.ts' } },
      { type: 'stream.delta', payload: { kind: 'text', text: 'First complete result.' } },
      { type: 'session.status', payload: { status: 'waiting', live: true } },
      { type: 'stream.delta', payload: { kind: 'user', text: '\n› check the edge case\n' } },
      { type: 'stream.delta', payload: { kind: 'text', text: 'Final ' } },
      { type: 'stream.delta', payload: { kind: 'text', text: 'reviewed result.' } },
      { type: 'session.status', payload: { status: 'waiting', live: true } },
      { type: 'stream.delta', payload: { kind: 'user', text: '\n› one more thing\n' } },
      { type: 'stream.delta', payload: { kind: 'text', text: 'Still streaming; do not return me.' } },
    ])

    const result = builder.build({
      childSessionId: 'ses_child',
      childAgent: 'codex',
      childTitle: 'Review · parser',
      role: 'review',
    })
    expect(result.returnText).toBe('Final reviewed result.')
    expect(result.attribution).toContain('Returned from Codex · Review')
    expect(result.context).toMatchObject({ truncated: false, omittedCharacters: 0 })
  })

  it('refuses a partial response with no completion boundary', () => {
    start()
    log.append('ses_child', { type: 'stream.delta', payload: { kind: 'text', text: 'not done' } })
    expect(() => builder.build({
      childSessionId: 'ses_child',
      childAgent: 'codex',
      childTitle: 'child',
      role: 'review',
    })).toThrowError(ReturnBuilderError)
  })

  it('bounds a huge return deterministically and reports the omitted characters', () => {
    start()
    const huge = `HEAD-${'x'.repeat(MAX_DELEGATION_RETURN_CHARACTERS)}-TAIL`
    log.appendBatch('ses_child', [
      { type: 'stream.delta', payload: { kind: 'text', text: huge } },
      { type: 'session.status', payload: { status: 'waiting', live: true } },
    ])
    const result = builder.build({
      childSessionId: 'ses_child',
      childAgent: 'claude',
      childTitle: 'child',
      role: 'test',
    })
    expect(result.returnText).toHaveLength(MAX_DELEGATION_RETURN_CHARACTERS)
    expect(result.returnText).toContain('earlier middle content omitted')
    expect(result.returnText.startsWith('HEAD-')).toBe(true)
    expect(result.returnText.endsWith('-TAIL')).toBe(true)
    expect(result.context.truncated).toBe(true)
    expect(result.context.omittedCharacters).toBeGreaterThan(0)
  })
})
