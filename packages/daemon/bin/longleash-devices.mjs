#!/usr/bin/env node
/**
 * Paired devices, and how to un-pair one you no longer trust.
 *
 *   longleash devices              list every device that can reach this laptop
 *   longleash revoke <id|name>     cut one off, immediately and permanently
 *
 * This runs on the LAPTOP on purpose. Revocation is authorised by a 0600 secret only a
 * local process can read, which makes physical possession of the machine the root of
 * trust: someone holding a stolen, unlocked phone can neither revoke your other devices
 * nor un-revoke themselves.
 *
 * It talks to the RUNNING daemon rather than editing the database directly, because the
 * things that make revocation real — closing the open socket, shutting the relay room,
 * dropping the push subscription — live inside that process. A row updated behind its
 * back would leave a stolen phone revoked on paper and still listening in practice.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir = process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash')

function endpoint() {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(dataDir, 'hook-endpoint.json'), 'utf8'))
  } catch {
    return null
  }
  return raw?.url && raw?.secret ? raw : null
}

const NOT_RUNNING = [
  'LongLeash does not appear to be running, so there is nothing to revoke against.',
  '',
  'Revoking has to go through the running daemon: that is what actually closes the',
  'device’s connection and shuts its relay room. Start it and try again:',
  '',
  '  longleash',
].join('\n')

async function call(path, init) {
  const ep = endpoint()
  if (ep === null) {
    console.error(NOT_RUNNING)
    process.exit(1)
  }
  const base = ep.url.replace(/\/hook$/, '')
  let response
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-longleash-hook': ep.secret, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    console.error(NOT_RUNNING)
    process.exit(1)
  }
  if (response.status === 401) {
    console.error('The daemon refused this request. Restart LongLeash and try again.')
    process.exit(1)
  }
  return response
}

const ago = (ms) => {
  if (ms === null || ms === undefined) return 'never'
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

async function list() {
  const response = await call('/devices', { method: 'GET' })
  const { devices } = await response.json()
  const live = devices.filter((d) => d.revokedAt === null)
  if (live.length === 0) {
    console.log('No devices are paired. Scan the QR code shown by `longleash` to add your phone.')
    return devices
  }
  console.log('')
  console.log('  DEVICE                                  LAST SEEN     STATUS')
  for (const d of live) {
    const status = d.connected ? 'connected' : 'idle'
    console.log(`  ${d.deviceId.padEnd(38).slice(0, 38)}  ${ago(d.lastSeenAt).padEnd(12)}  ${status}`)
    console.log(`    ${d.name.slice(0, 70)}`)
  }
  const revoked = devices.length - live.length
  console.log('')
  if (revoked > 0) console.log(`  (${revoked} revoked device${revoked === 1 ? '' : 's'} not shown)`)
  console.log('  Lost a phone?  longleash revoke <device-id>')
  console.log('')
  return devices
}

/**
 * Cut every paired device loose at once, for when testing has left a pile of them and you
 * want one clean phone again. Deliberately a separate, explicit flag: `revoke <id>` should
 * never be one typo away from cutting off everything.
 */
async function revokeAll() {
  const response = await call('/devices', { method: 'GET' })
  const { devices } = await response.json()
  const live = devices.filter((d) => d.revokedAt === null)
  if (live.length === 0) {
    console.log('Nothing is paired. Scan the QR from `longleash` to add your phone.')
    return
  }

  console.log('')
  console.log(`About to revoke ALL ${live.length} paired device(s).`)
  console.log('Every one of them disconnects immediately and cannot reconnect.')
  console.log('You will pair again by scanning the QR code that `longleash` prints.')
  console.log('')

  let done = 0
  for (const device of live) {
    const result = await call('/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.deviceId }),
    })
    if (result.ok) done += 1
    else console.error(`  could not revoke ${device.deviceId}`)
  }

  console.log(`Revoked ${done} of ${live.length}.`)
  console.log('Their relay rooms are shut and their notifications have stopped.')
  console.log('')
  console.log('Scan the QR code in the `longleash` terminal to pair your phone again.')
  console.log('')
}

async function revoke(needle) {
  const response = await call('/devices', { method: 'GET' })
  const { devices } = await response.json()
  const live = devices.filter((d) => d.revokedAt === null)

  // Match on the full id, an unambiguous prefix, or the device name — nobody types a
  // full opaque id from memory while their phone is in someone else's pocket.
  const lower = needle.toLowerCase()
  let matches = live.filter((d) => d.deviceId === needle)
  if (matches.length === 0) {
    matches = live.filter(
      (d) => d.deviceId.toLowerCase().startsWith(lower) || d.name.toLowerCase().includes(lower),
    )
  }

  if (matches.length === 0) {
    console.error(`No paired device matches "${needle}".`)
    console.error('Run `longleash devices` to see what is paired.')
    process.exit(1)
  }
  if (matches.length > 1) {
    // Never guess which device to cut off.
    console.error(`"${needle}" matches ${matches.length} devices. Be more specific:`)
    for (const d of matches) console.error(`  ${d.deviceId}  ${d.name.slice(0, 50)}`)
    process.exit(1)
  }

  const target = matches[0]
  const done = await call('/devices/revoke', {
    method: 'POST',
    body: JSON.stringify({ deviceId: target.deviceId }),
  })
  if (!done.ok) {
    console.error(`Could not revoke ${target.deviceId}: ${(await done.json()).reason ?? done.status}`)
    process.exit(1)
  }

  console.log('')
  console.log(`Revoked ${target.deviceId}`)
  console.log(`  ${target.name.slice(0, 70)}`)
  console.log('')
  console.log('That device is now disconnected, its relay room is shut, and it will receive')
  console.log('no further notifications. It cannot reconnect, and this cannot be undone —')
  console.log('pair the phone again from scratch if it turns out to be yours after all.')
  console.log('')
}

const [command, argument] = process.argv.slice(2)
try {
  if (command === 'revoke' && (argument === '--all' || argument === 'all')) {
    await revokeAll()
  } else if (command === 'revoke') {
    if (!argument) {
      console.error('Which device? Run `longleash devices` to see them, then:')
      console.error('  longleash revoke <device-id>      one device')
      console.error('  longleash revoke --all           every device, to start fresh')
      process.exit(1)
    }
    await revoke(argument)
  } else {
    await list()
  }
} catch (error) {
  console.error(`Could not talk to LongLeash: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
