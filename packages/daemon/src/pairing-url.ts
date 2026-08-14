/**
 * Put one-time pairing credentials in the URL fragment. Fragments are available to browser code
 * after navigation but are not included in the HTTP request sent to the origin.
 */
export function pairingUrl(
  appOrigin: string,
  challengeId: string,
  secret: string,
): string {
  const url = new URL(appOrigin)
  url.search = ''
  url.hash = new URLSearchParams({ c: challengeId, s: secret }).toString()
  return url.toString()
}
