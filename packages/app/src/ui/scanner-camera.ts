export type ScannerCamera = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>

type FocusCapabilities = MediaTrackCapabilities & {
  focusMode?: string[]
}

/**
 * iPhones can expose the physical ultra-wide/telephoto cameras as well as Apple's virtual
 * "Back Camera". For QR work the virtual/default back camera is the safest first choice: it can
 * autofocus and lets iOS select an appropriate physical lens. Keep every rear lens available so
 * the user can still switch if a particular phone/browser combination chooses badly.
 */
export function cameraScore(label: string): number {
  const value = label.trim().toLowerCase()
  if (!value) return 0
  if (/front|facetime|true\s*depth|user/.test(value)) return -500

  let score = 0
  if (/back|rear|environment/.test(value)) score += 120
  if (/^(back|rear)( camera)?$/.test(value)) score += 300
  if (/dual|triple/.test(value)) score += 30
  if (/\bwide\b/.test(value)) score += 20
  if (/ultra[ -]?wide|telephoto|\btele\b/.test(value)) score -= 160
  return score
}

export function rankScannerCameras(devices: ScannerCamera[]): ScannerCamera[] {
  const video = devices.filter((device) => device.kind === 'videoinput')
  const rear = video.filter((device) => /back|rear|environment/i.test(device.label))
  const notFront = video.filter((device) => cameraScore(device.label) > -500)
  const candidates = rear.length > 0 ? rear : notFront.length > 0 ? notFront : video

  return candidates
    .map((device, index) => ({ device, index }))
    .sort((a, b) => cameraScore(b.device.label) - cameraScore(a.device.label) || a.index - b.index)
    .map(({ device }) => device)
}

export function shouldPreferCamera(current: ScannerCamera | undefined, best: ScannerCamera | undefined): boolean {
  if (!current || !best || current.deviceId === best.deviceId) return false
  return cameraScore(best.label) >= cameraScore(current.label) + 80
}

export function scannerVideoConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } }),
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  }
}

export function supportedFocusModes(track: MediaStreamTrack): string[] {
  const capabilities = track.getCapabilities() as FocusCapabilities
  return Array.isArray(capabilities.focusMode) ? capabilities.focusMode : []
}

export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/** Map a visible viewfinder through `object-fit: cover` into source-video pixels. */
export function coverCrop(
  videoWidth: number,
  videoHeight: number,
  videoBox: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  frameBox: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): CropRect {
  if (videoWidth <= 0 || videoHeight <= 0 || videoBox.width <= 0 || videoBox.height <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(videoWidth, 1), sh: Math.max(videoHeight, 1) }
  }

  const scale = Math.max(videoBox.width / videoWidth, videoBox.height / videoHeight)
  const overflowX = (videoWidth * scale - videoBox.width) / 2
  const overflowY = (videoHeight * scale - videoBox.height) / 2
  const rawX = (frameBox.left - videoBox.left + overflowX) / scale
  const rawY = (frameBox.top - videoBox.top + overflowY) / scale
  const rawWidth = frameBox.width / scale
  const rawHeight = frameBox.height / scale
  const sx = Math.max(0, Math.min(videoWidth - 1, rawX))
  const sy = Math.max(0, Math.min(videoHeight - 1, rawY))

  return {
    sx,
    sy,
    sw: Math.max(1, Math.min(rawWidth, videoWidth - sx)),
    sh: Math.max(1, Math.min(rawHeight, videoHeight - sy)),
  }
}
