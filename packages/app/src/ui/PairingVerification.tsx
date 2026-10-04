import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { PairingControl, PairingProgress } from '../lib/verified-pairing.js'

export function PairingVerification({ progress, control, onCancel }: {
  progress: PairingProgress; control: PairingControl | null; onCancel: () => void;
}) {
  const reduced = useReducedMotion()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const seconds = progress.expiresAt ? Math.max(0, Math.ceil((progress.expiresAt - now) / 1000)) : null
  const expired = seconds === 0
  return <main className="gate pair-verify">
    <p className="mono pair-eyebrow">DEVICE VERIFICATION</p>
    <h1>{expired ? 'This code expired' : progress.state === 'connecting' ? 'Finding your laptop' : progress.state === 'waiting' ? 'Confirm on your laptop' : 'Compare with your laptop'}</h1>
    <p role="status">{expired ? 'Generate a fresh QR with longleash pair and try again.' : progress.state === 'connecting'
      ? 'Keep this page and the pairing terminal open. No device is connected yet.'
      : progress.state === 'waiting' ? 'Your phone confirmation is recorded. Finish the comparison in the laptop terminal; this page will continue when both agree.'
      : 'Check every digit against the code in your laptop terminal. Confirm only if both codes match.'}</p>
    {progress.code && <motion.div className="pair-code" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : 0.18 }}>
      <span className="mono" aria-label={`Verification code ${progress.code.replaceAll(' ', '').split('').join(' ')}`}>{progress.code}</span>
    </motion.div>}
    {seconds !== null && <p className="mono pair-expiry">{expired ? 'Expired' : `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</p>}
    {progress.state === 'compare' && <div className="pair-actions">
      <button className="pair-action pair-match" disabled={expired || !control} onClick={() => control?.confirm()}>Codes match</button>
      <button className="pair-action" onClick={() => control?.reject()}>They do not match</button>
    </div>}
    <button className="pair-action" onClick={onCancel}>Cancel pairing</button>
    <p className="pair-private">Keep the QR and pairing link private. Pairing never asks for an agent password or permission to weaken your security.</p>
  </main>
}
