import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventLog } from '../src/eventlog.js'

const dbPath = join(dirname(fileURLToPath(import.meta.url)), 'demo-events.db')
const firstRun = !existsSync(dbPath)

console.log('\n=== LongLeash event log: eyes-on demo ===')
console.log(`Database file: ${dbPath}`)
console.log(firstRun ? 'No database yet — this is run #1.' : 'Found data from a previous run — durability in action.')

const log = new EventLog(dbPath)
const SESSION = 'demo-session'
const before = log.latestSeq(SESSION)

console.log(`\n[1] Events already stored from previous runs: ${before}`)

console.log('\n[2] Appending this run\'s events (a start marker on run #1, then two output chunks)...')
if (before === 0) {
  log.append(SESSION, {
    type: 'session.started',
    payload: { agent: 'claude', cwd: process.cwd(), title: 'eyes-on demo' },
  })
}
const stamp = new Date().toLocaleTimeString()
log.append(SESSION, { type: 'stream.delta', payload: { kind: 'text', text: `output chunk written at ${stamp}` } })
log.append(SESSION, { type: 'stream.delta', payload: { kind: 'text', text: `second chunk at ${stamp}` } })

const all = log.replay(SESSION, 0)
if (!all.gap) {
  console.log(`\n[3] Full replay from cursor 0 — ${all.events.length} events, in exact order:`)
  for (const ev of all.events.slice(-6)) {
    const detail = ev.type === 'stream.delta' ? (ev.payload as { text: string }).text : JSON.stringify(ev.payload).slice(0, 60)
    console.log(`    seq ${String(ev.seq).padStart(3)} | ${ev.type.padEnd(18)} | ${detail}`)
  }
  if (all.events.length > 6) console.log(`    (showing last 6 of ${all.events.length})`)
}

const partial = log.replay(SESSION, before)
if (!partial.gap) {
  console.log(`\n[4] Phone reconnects with cursor ${before} ("I already have ${before} events") — gets ONLY the new ones:`)
  for (const ev of partial.events) console.log(`    seq ${ev.seq} | ${ev.type}`)
}

const broken = log.replay(SESSION, 9999)
console.log('\n[5] Phone claims cursor 9999 (impossible — e.g. daemon was reset). No silent lie, an explicit signal:')
console.log(`    ${JSON.stringify(broken)}`)

console.log('\n[6] Trying to sneak an invalid event into a batch of 3 — the whole batch must vanish:')
const countBefore = log.latestSeq(SESSION)
try {
  log.appendBatch(SESSION, [
    { type: 'stream.delta', payload: { kind: 'text', text: 'valid one' } },
    { type: 'stream.delta', payload: {} as never },
    { type: 'stream.delta', payload: { kind: 'text', text: 'never lands' } },
  ])
} catch {
  console.log('    Rejected as expected.')
}
console.log(`    Events before: ${countBefore}, after: ${log.latestSeq(SESSION)} — nothing leaked through.`)

log.close()
const reopened = new EventLog(dbPath)
console.log(`\n[7] Closed and reopened the database: ${reopened.latestSeq(SESSION)} events intact.`)
reopened.close()

console.log('\nRun this again and the count keeps growing across runs.')
console.log('Kill it whenever you like (Ctrl+C) — committed events never corrupt.')
console.log('Delete demo/demo-events.db to start fresh.\n')
