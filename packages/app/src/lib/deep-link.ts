/**
 * Notification links use `session`; pairing links use `c` + `s` (the secret). Older
 * notification builds used `s`, so accept that only when it cannot be a pairing secret.
 */
export function sessionFromSearch(search: string): string | null {
  const params = new URLSearchParams(search)
  return params.get('session') ?? (params.has('c') ? null : params.get('s'))
}

export function hasSessionLink(search: string): boolean {
  return sessionFromSearch(search) !== null
}
