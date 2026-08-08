import { execSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

export interface Candidate {
  iface: string
  address: string
  label: string
  rank: number
}

/**
 * Not every IPv4 address a Mac holds is reachable from a phone:
 *  - 169.254.x  self-assigned; DHCP failed, nothing routes there
 *  - 192.0.0.x  iOS service-continuity range (RFC 7335); Safari refuses it
 *  - public IPs usually belong to a VPN tunnel, not the LAN
 * Rank what is left so the hotspot subnet wins when it exists.
 */
export function findCandidates(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Candidate[] {
  const out: Candidate[] = []
  for (const [iface, nets] of Object.entries(interfaces)) {
    for (const net of nets ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      const ip = net.address
      if (ip.startsWith('169.254.')) continue
      if (ip.startsWith('192.0.0.')) continue

      if (ip.startsWith('172.20.10.')) {
        out.push({ iface, address: ip, label: 'iPhone hotspot', rank: 0 })
      } else if (ip.startsWith('192.168.') || ip.startsWith('10.')) {
        out.push({ iface, address: ip, label: 'local network', rank: 1 })
      } else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) {
        out.push({ iface, address: ip, label: 'local network', rank: 1 })
      }
    }
  }
  return out.sort((a, b) => a.rank - b.rank)
}

export function vpnWarning(): string | null {
  try {
    const route = execSync('route -n get default 2>/dev/null', { encoding: 'utf8' })
    const iface = /interface:\s*(\S+)/.exec(route)?.[1]
    if (iface?.startsWith('utun') || iface?.startsWith('ipsec')) {
      return `A VPN appears to be active (default route via ${iface}). Full-tunnel VPNs swallow phone-to-laptop traffic — disconnect it for this test.`
    }
  } catch {
    // Diagnostics are best-effort; never block the demo on them.
  }
  return null
}

/**
 * Why there is nothing to bind to, in words a person can act on. USB tethering is the
 * case worth naming: macOS then holds only 192.0.0.2 (the iOS service-continuity range),
 * which looks like a working connection and is not one a phone browser can dial.
 */
export function noAddressReason(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string {
  const addresses: string[] = []
  for (const nets of Object.values(interfaces)) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address)
    }
  }
  if (addresses.some((ip) => ip.startsWith('192.0.0.'))) {
    return 'Your phone appears to be tethered over USB, which gives this Mac no address a browser can reach. Use the phone\u2019s Wi-Fi hotspot instead, or rely on the relay.'
  }
  if (addresses.some((ip) => ip.startsWith('169.254.'))) {
    return 'This Mac has a self-assigned address, which means it never got one from the network.'
  }
  if (addresses.length === 0) return 'This Mac has no network connection at all.'
  return `No address a phone could dial (found: ${addresses.join(', ')}).`
}
