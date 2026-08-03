/**
 * Lock-screen alerts, phone side. iOS grants push only to an installed home-screen
 * app and only from a real tap, so everything here is built to be called from a
 * key press — and to fail into silence, never into a broken console.
 */

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported'
}

/**
 * Ask for permission (must be inside a user gesture) and subscribe.
 * Returns the subscription JSON to send to the daemon, or null if refused/failed.
 */
export async function enablePush(publicKey: string): Promise<unknown | null> {
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return null
    return await subscribe(publicKey)
  } catch {
    return null
  }
}

/**
 * With permission already granted, make sure a subscription exists and return it.
 * Called on every hello so a daemon that lost its database heals on the next visit.
 */
export async function syncPush(publicKey: string): Promise<unknown | null> {
  try {
    if (Notification.permission !== 'granted') return null
    return await subscribe(publicKey)
  } catch {
    return null
  }
}

async function subscribe(publicKey: string): Promise<unknown> {
  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  if (existing) return existing.toJSON()
  const created = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyBytes(publicKey),
  })
  return created.toJSON()
}

/** The VAPID key arrives base64url; PushManager wants raw bytes. */
function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}
