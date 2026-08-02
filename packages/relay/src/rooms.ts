export type Role = 'host' | 'guest'

export type JoinResult =
  | { ok: true; host: boolean; guests: number }
  | { ok: false; reason: 'host-taken' | 'room-full' | 'already-joined' }

export interface LeaveResult<T> {
  room: string
  role: Role
  /** Everyone still seated in the room, so the caller can tell them. */
  peers: T[]
}

interface Room<T> {
  host: T | null
  guests: Set<T>
}

/**
 * Membership and routing for the relay — and nothing else. A room is an opaque tag two paired
 * devices both know; the registry never learns what a tag means or what the frames carry. One
 * host (the daemon) per room, a bounded number of guests (phones): guest frames go to the
 * host, host frames fan out to guests, guests never see each other. Pure bookkeeping with no
 * I/O, so every rule is testable without a socket in sight.
 */
export class Rooms<T> {
  private readonly rooms = new Map<string, Room<T>>()
  private readonly membership = new Map<T, { room: string; role: Role }>()
  private readonly maxGuests: number

  constructor(opts: { maxGuests: number }) {
    this.maxGuests = opts.maxGuests
  }

  /** How many rooms currently exist — exposed so tests can prove nothing lingers. */
  get size(): number {
    return this.rooms.size
  }

  join(roomTag: string, role: Role, member: T): JoinResult {
    if (this.membership.has(member)) return { ok: false, reason: 'already-joined' }
    const room = this.rooms.get(roomTag) ?? { host: null, guests: new Set<T>() }

    if (role === 'host') {
      // One daemon owns a pairing. A second "host" is a reconnect race at best and a
      // squatter at worst; either way the seat is taken until the first connection dies.
      if (room.host !== null) return { ok: false, reason: 'host-taken' }
      room.host = member
    } else {
      if (room.guests.size >= this.maxGuests) return { ok: false, reason: 'room-full' }
      room.guests.add(member)
    }

    this.rooms.set(roomTag, room)
    this.membership.set(member, { room: roomTag, role })
    return { ok: true, host: room.host !== null, guests: room.guests.size }
  }

  /** Where a frame from this member must be delivered. Unknown members route nowhere. */
  targetsFor(member: T): T[] {
    const seat = this.membership.get(member)
    if (!seat) return []
    const room = this.rooms.get(seat.room)
    if (!room) return []
    if (seat.role === 'guest') return room.host === null ? [] : [room.host]
    return [...room.guests]
  }

  /** Everyone else in this member's room — the audience for presence notifications. */
  peersOf(member: T): T[] {
    const seat = this.membership.get(member)
    if (!seat) return []
    const room = this.rooms.get(seat.room)
    if (!room) return []
    const others: T[] = []
    if (room.host !== null && room.host !== member) others.push(room.host)
    for (const guest of room.guests) if (guest !== member) others.push(guest)
    return others
  }

  roleOf(member: T): Role | null {
    return this.membership.get(member)?.role ?? null
  }

  /** Occupancy of this member's room, for join acknowledgements. */
  occupancy(member: T): { host: boolean; guests: number } {
    const seat = this.membership.get(member)
    const room = seat === undefined ? undefined : this.rooms.get(seat.room)
    if (!room) return { host: false, guests: 0 }
    return { host: room.host !== null, guests: room.guests.size }
  }

  leave(member: T): LeaveResult<T> | null {
    const seat = this.membership.get(member)
    if (!seat) return null
    this.membership.delete(member)
    const room = this.rooms.get(seat.room)
    if (!room) return null

    if (seat.role === 'host' && room.host === member) room.host = null
    else room.guests.delete(member)

    const peers = [
      ...(room.host === null ? [] : [room.host]),
      ...room.guests,
    ]
    // An empty room evaporates: a rendezvous service must hold no residue of who met whom.
    if (room.host === null && room.guests.size === 0) this.rooms.delete(seat.room)
    return { room: seat.room, role: seat.role, peers }
  }
}
