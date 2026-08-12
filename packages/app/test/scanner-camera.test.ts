import { describe, expect, it } from 'vitest'
import {
  cameraScore,
  coverCrop,
  rankScannerCameras,
  scannerVideoConstraints,
  shouldPreferCamera,
  type ScannerCamera,
} from '../src/ui/scanner-camera.js'

function camera(deviceId: string, label: string): ScannerCamera {
  return { deviceId, label, kind: 'videoinput' }
}

describe('QR scanner camera selection', () => {
  it('prefers the default autofocus back camera but keeps alternate rear lenses', () => {
    const ranked = rankScannerCameras([
      camera('front', 'Front Camera'),
      camera('ultra', 'Back Ultra Wide Camera'),
      camera('triple', 'Back Triple Camera'),
      camera('default', 'Back Camera'),
    ])

    expect(ranked.map(({ deviceId }) => deviceId)).toEqual(['default', 'triple', 'ultra'])
    expect(cameraScore('Front Camera')).toBeLessThan(0)
    expect(shouldPreferCamera(ranked[1], ranked[0])).toBe(true)
  })

  it('keeps unlabeled cameras usable before a browser exposes device labels', () => {
    expect(rankScannerCameras([camera('one', ''), camera('two', '')])).toHaveLength(2)
  })

  it('requests a crisp rear stream and can pin an explicitly selected lens', () => {
    expect(scannerVideoConstraints()).toMatchObject({
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    })
    expect(scannerVideoConstraints('rear-wide')).toMatchObject({
      deviceId: { exact: 'rear-wide' },
    })
  })
})

describe('QR scanner viewfinder crop', () => {
  it('maps the visible portrait viewfinder into a landscape object-cover stream', () => {
    const crop = coverCrop(
      1920,
      1080,
      { left: 0, top: 0, width: 390, height: 844 },
      { left: 43, top: 170, width: 304, height: 304 },
    )

    // Scanning the whole 1920px frame made a QR in the 304px finder needlessly small. The crop
    // should contain only the roughly 389px-wide source region that is actually inside it.
    expect(crop.sw).toBeGreaterThan(385)
    expect(crop.sw).toBeLessThan(392)
    expect(crop.sh).toBeGreaterThan(385)
    expect(crop.sx).toBeGreaterThan(700)
    expect(crop.sx + crop.sw).toBeLessThan(1220)
  })

  it('falls back safely before video metadata has loaded', () => {
    expect(coverCrop(0, 0, { left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 0, height: 0 }))
      .toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 })
  })
})
