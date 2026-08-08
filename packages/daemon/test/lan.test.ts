import { describe, it, expect } from 'vitest'
import { findCandidates, noAddressReason } from '../demo/lan.js'

type Nets = Parameters<typeof findCandidates>[0]

const iface = (address: string, internal = false) =>
  [{ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }] as unknown as NonNullable<Nets>[string]

describe('finding an address a phone can actually dial', () => {
  it('prefers the iPhone hotspot subnet over an ordinary network', () => {
    const found = findCandidates({ en0: iface('192.168.1.44'), en1: iface('172.20.10.3') })
    expect(found[0]).toMatchObject({ address: '172.20.10.3', label: 'iPhone hotspot' })
    expect(found[1]).toMatchObject({ address: '192.168.1.44' })
  })

  it('accepts every private range, not just the two obvious ones', () => {
    expect(findCandidates({ a: iface('10.1.10.89') })).toHaveLength(1)
    expect(findCandidates({ a: iface('192.168.0.5') })).toHaveLength(1)
    expect(findCandidates({ a: iface('172.16.4.2') })).toHaveLength(1)
    expect(findCandidates({ a: iface('172.31.255.1') })).toHaveLength(1)
  })

  it('rejects addresses that look connected but cannot be reached', () => {
    // Self-assigned: DHCP never answered.
    expect(findCandidates({ a: iface('169.254.1.2') })).toEqual([])
    // iOS service-continuity range — what USB tethering leaves behind.
    expect(findCandidates({ a: iface('192.0.0.2') })).toEqual([])
    // Loopback is never a way in from a phone.
    expect(findCandidates({ lo0: iface('127.0.0.1', true) })).toEqual([])
    // A public address is almost always a VPN tunnel, not the LAN.
    expect(findCandidates({ utun0: iface('100.64.3.9') })).toEqual([])
  })
})

describe('saying WHY there is nothing to bind to', () => {
  it('names USB tethering, the case that looks connected and is not', () => {
    // The real failure: a Mac holding only 192.0.0.2 refused to start the daemon at all,
    // even though the relay needed no local address whatsoever.
    expect(noAddressReason({ en0: iface('192.0.0.2') })).toContain('tethered over USB')
  })

  it('distinguishes a failed DHCP lease from no network at all', () => {
    expect(noAddressReason({ en0: iface('169.254.9.9') })).toContain('self-assigned')
    expect(noAddressReason({})).toContain('no network connection')
  })

  it('otherwise lists what it did find, so the report is checkable', () => {
    expect(noAddressReason({ utun0: iface('100.64.3.9') })).toContain('100.64.3.9')
  })
})
