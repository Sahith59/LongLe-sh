import { describe, expect, it } from 'vitest'
import { persistentServiceLogLine } from '../src/service-log.js'

describe('durable service logging boundary', () => {
  it('keeps lifecycle evidence without persisting project paths', () => {
    const line = '[12:34:56] claude session abc123 started in /Users/alice/secret-project (vscode)'
    expect(persistentServiceLogLine(line)).toBe('[12:34:56] claude session abc123 started (vscode)')
  })

  it('drops provider protocol frames that may contain prompts or code', () => {
    expect(persistentServiceLogLine('[12:34:56] codex <- {"prompt":"private source"}')).toBeNull()
    expect(persistentServiceLogLine('[12:34:56] codex -> password=never-log-this')).toBeNull()
  })

  it('fails closed on arbitrary values, URLs, errors, device names, and tool input', () => {
    const secrets = [
      '[12:34:56] delegation refused: token=super-secret',
      '[12:34:56] device Alice’s iPhone connected (dev_secret)',
      '[12:34:56] ? Bash in abc123 (mode: default) -> allow: rm private-file',
      '[12:34:56] unknown https://relay.example/#c=x&s=single-use',
      '[12:34:56] Error HOME=/Users/alice PRIVATE_KEY=secret',
    ]
    for (const source of secrets) {
      const safe = persistentServiceLogLine(source) ?? ''
      for (const forbidden of ['super-secret', 'Alice', 'rm private-file', 'single-use', '/Users/alice', 'PRIVATE_KEY']) {
        expect(safe).not.toContain(forbidden)
      }
    }
  })
})
