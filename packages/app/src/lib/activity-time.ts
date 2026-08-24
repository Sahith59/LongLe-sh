export interface ActivityTime {
  label: string
  title: string
  dateTime: string
}

/** Compact in the list, exact on long-press/hover and for assistive technology. */
export function activityTime(timestamp: number | undefined, now = Date.now()): ActivityTime | null {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  const delta = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const label = delta < minute
    ? 'now'
    : delta < hour
      ? `${Math.floor(delta / minute)}m ago`
      : delta < day
        ? `${Math.floor(delta / hour)}h ago`
        : delta < 7 * day
          ? `${Math.floor(delta / day)}d ago`
          : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return {
    label,
    title: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    dateTime: date.toISOString(),
  }
}
