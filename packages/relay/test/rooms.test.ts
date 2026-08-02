import { describe, expect, it } from 'vitest'
import { Rooms } from '../src/rooms.js'

/** Members are opaque to the registry; tests use plain labels. */
const rooms = () => new Rooms<string>({ maxGuests: 3 })

describe('claiming a room', () => {
  it('seats one host and any number of guests up to the cap', () => {
    const r = rooms()
    expect(r.join('room-a', 'host', 'laptop')).toEqual({ ok: true, host: true, guests: 0 })
    expect(r.join('room-a', 'guest', 'phone-1')).toEqual({ ok: true, host: true, guests: 1 })
    expect(r.join('room-a', 'guest', 'phone-2')).toEqual({ ok: true, host: true, guests: 2 })
  })

  it('refuses a second host — one daemon owns a pairing, always', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop')
    expect(r.join('room-a', 'host', 'impostor')).toEqual({ ok: false, reason: 'host-taken' })
  })

  it('a guest may arrive before the host and is told the host is absent', () => {
    const r = rooms()
    expect(r.join('room-a', 'guest', 'phone')).toEqual({ ok: true, host: false, guests: 1 })
  })

  it('caps guests so a leaked room tag cannot exhaust the relay', () => {
    const r = rooms()
    r.join('room-a', 'guest', 'g1')
    r.join('room-a', 'guest', 'g2')
    r.join('room-a', 'guest', 'g3')
    expect(r.join('room-a', 'guest', 'g4')).toEqual({ ok: false, reason: 'room-full' })
  })

  it('refuses a member joining twice', () => {
    const r = rooms()
    r.join('room-a', 'guest', 'phone')
    expect(r.join('room-b', 'guest', 'phone')).toEqual({ ok: false, reason: 'already-joined' })
  })
})

describe('routing — the entire job', () => {
  it('a guest frame goes to the host and only the host', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop')
    r.join('room-a', 'guest', 'phone-1')
    r.join('room-a', 'guest', 'phone-2')
    expect(r.targetsFor('phone-1')).toEqual(['laptop'])
  })

  it('a host frame fans out to every guest', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop')
    r.join('room-a', 'guest', 'phone-1')
    r.join('room-a', 'guest', 'phone-2')
    expect(r.targetsFor('laptop').sort()).toEqual(['phone-1', 'phone-2'])
  })

  it('guests never see each other, and a hostless room routes nowhere', () => {
    const r = rooms()
    r.join('room-a', 'guest', 'phone-1')
    r.join('room-a', 'guest', 'phone-2')
    expect(r.targetsFor('phone-1')).toEqual([])
  })

  it('rooms are watertight — frames never cross between pairings', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop-a')
    r.join('room-b', 'host', 'laptop-b')
    r.join('room-a', 'guest', 'phone-a')
    expect(r.targetsFor('phone-a')).toEqual(['laptop-a'])
    expect(r.targetsFor('laptop-b')).toEqual([])
  })

  it('an unjoined member routes nowhere instead of crashing', () => {
    expect(rooms().targetsFor('ghost')).toEqual([])
  })
})

describe('leaving', () => {
  it('reports who left so the survivors can be told', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop')
    r.join('room-a', 'guest', 'phone')
    expect(r.leave('laptop')).toEqual({ room: 'room-a', role: 'host', peers: ['phone'] })
  })

  it('frees the host seat for a reconnecting daemon', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop')
    r.leave('laptop')
    expect(r.join('room-a', 'host', 'laptop-again')).toEqual({ ok: true, host: true, guests: 0 })
  })

  it('forgets empty rooms entirely — the relay must hold no residue', () => {
    const r = rooms()
    r.join('room-a', 'host', 'laptop')
    r.join('room-a', 'guest', 'phone')
    r.leave('laptop')
    r.leave('phone')
    expect(r.size).toBe(0)
  })

  it('leaving twice is a no-op, not a crash', () => {
    const r = rooms()
    r.join('room-a', 'guest', 'phone')
    r.leave('phone')
    expect(r.leave('phone')).toBeNull()
  })
})
