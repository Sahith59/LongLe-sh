import { closeSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import type { TerminalAgent } from './external.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resolve a hook's provisional id against the provider's durable conversation file. */
export function transcriptSessionId(agent: TerminalAgent, path: string): string | null {
  if (path === '') return null
  if (agent === 'claude') {
    const name = basename(path)
    const id = name.endsWith('.jsonl') ? name.slice(0, -6) : ''
    return UUID.test(id) ? id : null
  }
  try {
    const fd = openSync(path, 'r')
    let firstLine: string
    try {
      const buffer = Buffer.alloc(256 * 1024)
      firstLine = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n')[0] ?? ''
    } finally {
      closeSync(fd)
    }
    const record = JSON.parse(firstLine) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
    if (record.type !== 'session_meta') return null
    const id = record.payload?.id ?? record.payload?.session_id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}
