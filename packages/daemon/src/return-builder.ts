import {
  MAX_DELEGATION_RETURN_CHARACTERS,
  type DelegationRole,
  type SessionEvent,
} from '@longleash/protocol'
import type { EventLog } from './eventlog.js'

export interface ReturnDraft {
  returnText: string
  attribution: string
  context: {
    includedFirstSeq: number
    includedLastSeq: number
    omittedCharacters: number
    truncated: boolean
    characterCount: number
    maxCharacters: number
  }
}

export class ReturnBuilderError extends Error {
  constructor(
    readonly reason: 'unknown-child' | 'child-not-complete' | 'no-result' | 'context-pruned',
    message: string,
  ) {
    super(message)
    this.name = 'ReturnBuilderError'
  }
}

/**
 * Select the last completed assistant turn from the delegated child.
 *
 * Tool traces and thinking are deliberately excluded: the return boundary is a concise result
 * the user can review, not a hidden transfer of execution noise. A completion boundary is a
 * durable `waiting` or `ended` event, so partially streamed prose can never be returned as if it
 * were finished.
 */
export class ReturnBuilder {
  constructor(private readonly eventLog: EventLog) {}

  build(input: {
    childSessionId: string
    childAgent: string
    childTitle: string
    role: DelegationRole
  }): ReturnDraft {
    const replay = this.eventLog.replay(input.childSessionId, 0)
    if (replay.gap) {
      throw new ReturnBuilderError(
        'context-pruned',
        'The beginning of this child transcript was pruned, so LongLeash cannot prove a complete return boundary.',
      )
    }
    if (replay.events.length === 0) {
      throw new ReturnBuilderError('unknown-child', 'The delegated child transcript is unavailable.')
    }

    const completed = completedTurns(replay.events)
    if (completed.length === 0) {
      throw new ReturnBuilderError(
        'child-not-complete',
        'The delegated child has not finished a response yet. Wait until it is waiting for you.',
      )
    }
    const last = completed[completed.length - 1]!
    const full = last.text.trim()
    if (full === '') {
      throw new ReturnBuilderError('no-result', 'The child completed without a prose result to return.')
    }
    const bounded = boundResult(full)
    return {
      returnText: bounded.text,
      attribution: `Returned from ${agentName(input.childAgent)} · ${roleName(input.role)}\nChild session: ${input.childTitle || 'delegated session'}`,
      context: {
        includedFirstSeq: last.firstSeq,
        includedLastSeq: last.lastSeq,
        omittedCharacters: bounded.omittedCharacters,
        truncated: bounded.omittedCharacters > 0,
        characterCount: bounded.text.length,
        maxCharacters: MAX_DELEGATION_RETURN_CHARACTERS,
      },
    }
  }
}

function completedTurns(events: SessionEvent[]): { firstSeq: number; lastSeq: number; text: string }[] {
  const turns: { firstSeq: number; lastSeq: number; text: string }[] = []
  let afterUser = 0
  let text: { seq: number; value: string }[] = []
  for (const event of events) {
    if (event.type === 'stream.delta' && event.payload.kind === 'user') {
      afterUser = event.seq
      text = []
      continue
    }
    if (event.type === 'stream.delta' && event.payload.kind === 'text' && event.seq > afterUser) {
      text.push({ seq: event.seq, value: event.payload.text })
      continue
    }
    const boundary =
      (event.type === 'session.status' && event.payload.status === 'waiting') ||
      event.type === 'session.ended'
    if (!boundary || text.length === 0) continue
    turns.push({
      firstSeq: text[0]!.seq,
      lastSeq: event.seq,
      text: text.map((part) => part.value).join(''),
    })
    text = []
  }
  return turns
}

function boundResult(text: string): { text: string; omittedCharacters: number } {
  if (text.length <= MAX_DELEGATION_RETURN_CHARACTERS) return { text, omittedCharacters: 0 }
  const marker = '\n\n[… earlier middle content omitted by LongLeash …]\n\n'
  const budget = MAX_DELEGATION_RETURN_CHARACTERS - marker.length
  const head = Math.floor(budget * 0.4)
  const tail = budget - head
  return {
    text: text.slice(0, head) + marker + text.slice(-tail),
    omittedCharacters: text.length - budget,
  }
}

function agentName(agent: string): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  return agent
}

function roleName(role: DelegationRole): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1)
}
