import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Focus, SwitchCamera, X } from 'lucide-react'
import jsQR from 'jsqr'
import { EXIT, Key, SPRING } from './primitives.js'
import {
  coverCrop,
  rankScannerCameras,
  scannerVideoConstraints,
  shouldPreferCamera,
  supportedFocusModes,
  type ScannerCamera,
} from './scanner-camera.js'

const SCAN_SIZE = 720

/**
 * Scan the pairing QR inside the installed app. iOS may expose several rear lenses, so the
 * scanner asks for a high-resolution environment stream, prefers Apple's default back camera,
 * enables continuous focus when the browser exposes it, and still provides explicit lens/focus
 * recovery controls. Frames are cropped to the visible finder before decoding; on a portrait
 * phone, decoding the full landscape camera frame makes an otherwise crisp QR unnecessarily tiny.
 */
export function QrScanner({
  onCode,
  onClose,
}: {
  /** Called with the decoded text. Return true to stop scanning (accepted). */
  onCode: (text: string) => boolean
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const onCodeRef = useRef(onCode)
  const switchCameraRef = useRef<() => void>(() => {})
  const refocusRef = useRef<() => void>(() => {})
  const [failed, setFailed] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [cameras, setCameras] = useState<ScannerCamera[]>([])
  const [activeDeviceId, setActiveDeviceId] = useState('')
  const [focusNote, setFocusNote] = useState('Starting rear camera…')

  useEffect(() => {
    onCodeRef.current = onCode
  }, [onCode])

  useEffect(() => {
    let alive = true
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let availableCameras: ScannerCamera[] = []
    let currentDeviceId = ''
    const blockedDeviceIds = new Set<string>()
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })

    function scan() {
      const video = videoRef.current
      const frame = frameRef.current
      if (!video || !frame || !context || video.readyState < 2) return

      const crop = coverCrop(
        video.videoWidth,
        video.videoHeight,
        video.getBoundingClientRect(),
        frame.getBoundingClientRect(),
      )
      canvas.width = SCAN_SIZE
      canvas.height = SCAN_SIZE
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(
        video,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        SCAN_SIZE,
        SCAN_SIZE,
      )
      const pixels = context.getImageData(0, 0, SCAN_SIZE, SCAN_SIZE)
      const hit = jsQR(pixels.data, pixels.width, pixels.height, {
        inversionAttempts: 'attemptBoth',
      })
      if (hit?.data && onCodeRef.current(hit.data)) stop()
    }

    function stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
      for (const track of stream?.getTracks() ?? []) track.stop()
      stream = null
      const video = videoRef.current
      if (video) video.srcObject = null
    }

    async function applyFocusMode(track: MediaStreamTrack, mode: string): Promise<boolean> {
      try {
        const constraint = { focusMode: mode } as unknown as MediaTrackConstraintSet
        await track.applyConstraints({ advanced: [constraint] })
        return true
      } catch {
        return false
      }
    }

    async function enableContinuousFocus(track: MediaStreamTrack): Promise<boolean> {
      let modes: string[] = []
      try {
        modes = supportedFocusModes(track)
      } catch {
        return false
      }
      return modes.includes('continuous') && applyFocusMode(track, 'continuous')
    }

    async function enumerateCameras(): Promise<ScannerCamera[]> {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        return rankScannerCameras(devices).filter((device) => !blockedDeviceIds.has(device.deviceId))
      } catch {
        return []
      }
    }

    async function openCamera(deviceId?: string, discover = true): Promise<void> {
      stop()
      if (!alive) return
      setReady(false)
      setFailed(null)
      setFocusNote('Starting rear camera…')

      try {
        const granted = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: scannerVideoConstraints(deviceId),
        })
        if (!alive) {
          for (const track of granted.getTracks()) track.stop()
          return
        }

        stream = granted
        const track = granted.getVideoTracks()[0]
        if (!track) throw new Error('Camera returned no video track')
        currentDeviceId = track.getSettings().deviceId ?? deviceId ?? ''
        setActiveDeviceId(currentDeviceId)
        await enableContinuousFocus(track)

        const video = videoRef.current
        if (video) {
          video.srcObject = granted
          await video.play().catch(() => {})
        }
        if (!alive) return
        setReady(true)
        setFocusNote('Fit the full white border inside the frame and hold steady.')
        timer = setInterval(scan, 180)

        if (discover) {
          availableCameras = await enumerateCameras()
          if (!alive) return
          setCameras(availableCameras)
          const current = availableCameras.find((camera) => camera.deviceId === currentDeviceId)
          const best = availableCameras[0]
          if (shouldPreferCamera(current, best)) {
            await openCamera(best?.deviceId, false)
          }
        }
      } catch {
        if (deviceId && alive) {
          blockedDeviceIds.add(deviceId)
          await openCamera(undefined, true)
          return
        }
        if (alive) {
          setReady(false)
          setFailed('Camera unavailable. Paste the pairing link below the scanner instead.')
        }
      }
    }

    switchCameraRef.current = () => {
      if (availableCameras.length < 2) return
      const index = availableCameras.findIndex((camera) => camera.deviceId === currentDeviceId)
      const next = availableCameras[(index + 1 + availableCameras.length) % availableCameras.length]
      if (next) void openCamera(next.deviceId, false)
    }

    refocusRef.current = () => {
      const track = stream?.getVideoTracks()[0]
      if (!track) return
      void (async () => {
        setFocusNote('Refocusing…')
        let modes: string[] = []
        try {
          modes = supportedFocusModes(track)
        } catch {
          // Some Safari releases expose getCapabilities but throw for individual cameras.
        }

        let refreshed = false
        if (modes.includes('single-shot')) {
          refreshed = await applyFocusMode(track, 'single-shot')
          if (refreshed) await new Promise((resolve) => setTimeout(resolve, 300))
        }
        if (modes.includes('continuous')) {
          refreshed = (await applyFocusMode(track, 'continuous')) || refreshed
        }
        if (!refreshed) {
          await openCamera(currentDeviceId || undefined, false)
          return
        }
        if (alive) setFocusNote('Focus refreshed. Keep the white border inside the frame.')
      })()
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setFailed('This browser cannot open the camera. Paste the pairing link instead.')
    } else {
      void openCamera()
    }

    return () => {
      alive = false
      switchCameraRef.current = () => {}
      refocusRef.current = () => {}
      stop()
    }
  }, [])

  const activeCamera = cameras.find((camera) => camera.deviceId === activeDeviceId)
  const hint = failed ?? focusNote

  return (
    <motion.div
      className="scanner"
      role="dialog"
      aria-modal="true"
      aria-label="Scan the pairing QR"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: SPRING }}
      exit={{ opacity: 0, transition: EXIT }}
    >
      <video ref={videoRef} className="scanvid" autoPlay playsInline muted aria-hidden="true" />
      <div ref={frameRef} className="scanframe" aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div className="scancontrols">
        <div className="scanstatus" data-ready={ready && !failed ? 'true' : 'false'}>
          <span aria-hidden="true" />
          {failed ? 'Camera needs attention' : ready ? (activeCamera?.label || 'Rear camera ready') : 'Opening camera'}
        </div>
        <p className="scanhint" role="status">{hint}</p>
        <div className="scanactions">
          {ready && !failed ? (
            <Key className="scanfocus" onClick={() => refocusRef.current()} label="Refocus camera">
              <Focus size={18} strokeWidth={2.2} aria-hidden="true" />
              Refocus
            </Key>
          ) : null}
          {cameras.length > 1 && !failed ? (
            <Key className="scanswitch" onClick={() => switchCameraRef.current()} label="Switch rear camera lens">
              <SwitchCamera size={18} strokeWidth={2.2} aria-hidden="true" />
              Switch lens
            </Key>
          ) : null}
          <Key className="scanclose" onClick={onClose} label="Stop scanning">
            <X size={18} strokeWidth={2.4} aria-hidden="true" />
            Cancel
          </Key>
        </div>
      </div>
    </motion.div>
  )
}
