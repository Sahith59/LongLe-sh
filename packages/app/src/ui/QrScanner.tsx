import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import jsQR from 'jsqr'
import { EXIT, Key, SPRING } from './primitives.js'

/**
 * The camera, pointed at the terminal. Typing a 90-character pairing link on a
 * phone keyboard is the worst moment in the whole product, so the gate offers
 * a scanner: point at the QR the laptop printed, and pairing happens in THIS
 * app — which is the entire trick, because a scan from the iOS camera app
 * opens a separate browser whose pairing this app can never see.
 *
 * Safari has no BarcodeDetector, so frames are decoded in JS: draw the video
 * to a small canvas a few times a second and hand the pixels to jsQR. Cheap
 * enough that nobody notices, portable everywhere.
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
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })

    const scan = () => {
      const video = videoRef.current
      if (!video || !context || video.readyState < 2) return
      // Decode at reduced size: plenty for a QR, light on the battery.
      const scale = 400 / Math.max(video.videoWidth, 1)
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const hit = jsQR(pixels.data, pixels.width, pixels.height, {
        inversionAttempts: 'dontInvert',
      })
      if (hit && hit.data && onCode(hit.data)) {
        stop()
      }
    }

    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
      for (const track of stream?.getTracks() ?? []) track.stop()
      stream = null
    }

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((granted) => {
        if (!alive) {
          for (const track of granted.getTracks()) track.stop()
          return
        }
        stream = granted
        const video = videoRef.current
        if (video) {
          video.srcObject = granted
          void video.play().catch(() => {})
        }
        timer = setInterval(scan, 220)
      })
      .catch(() => {
        if (alive) setFailed('Camera unavailable. Paste the link instead — it works the same.')
      })

    return () => {
      alive = false
      stop()
    }
  }, [onCode])

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
      <video ref={videoRef} className="scanvid" playsInline muted aria-hidden="true" />
      <div className="scanframe" aria-hidden="true" />
      <p className="scanhint">
        {failed ?? 'Point at the QR in your laptop terminal. Press n there for a fresh one.'}
      </p>
      <Key className="scanclose" onClick={onClose} label="Stop scanning">
        <X size={18} strokeWidth={2.4} aria-hidden="true" />
        Cancel
      </Key>
    </motion.div>
  )
}
