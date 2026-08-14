/**
 * Notification links use the query's `session`; pairing links use fragment `c` + `s` now and
 * used the query in older builds. Older notification builds also used `s`, so accept that query
 * only when it cannot be a legacy pairing secret.
 */
export function sessionFromSearch(search: string): string | null {
  const params = new URLSearchParams(search)
  return params.get('session') ?? (params.has('c') ? null : params.get('s'))
}

export function hasSessionLink(search: string): boolean {
  return sessionFromSearch(search) !== null
}
