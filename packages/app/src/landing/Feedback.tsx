import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, CheckCircle2, Copy, MessageSquare, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { siteHref } from './SiteChrome.js'
import './feedback.css'

type Draft = { id: string; accessToken: string; category: string; subject: string; message: string }
type ThreadMessage = { id: string; author: 'customer' | 'owner'; body: string; status_snapshot: string; created_at: number }
type Ticket = { id: string; category: string; subject: string; message: string; reply: string; status: string;
  updated_at: number; expires_at: number | null; messages: ThreadMessage[] }
const DRAFT_KEY = 'longleash.support-draft.v1'

function fresh(): Draft {
  return { id: crypto.randomUUID(), accessToken: Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join(''), category: 'bug', subject: '', message: '' }
}
function initialDraft(): Draft {
  if (typeof window === 'undefined') return { id: '', accessToken: '', category: 'bug', subject: '', message: '' }
  const fragment = window.location.hash.slice(1).split('.')
  if (/^[a-f0-9-]{36}$/.test(fragment[0] ?? '') && /^[a-f0-9]{64}$/.test(fragment[1] ?? '')) {
    return { ...fresh(), id: fragment[0]!, accessToken: fragment[1]! }
  }
  try {
    const raw = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null
    if (raw && /^[a-f0-9-]{36}$/.test(raw.id) && /^[a-f0-9]{64}$/.test(raw.accessToken) &&
      ['bug', 'help', 'feature'].includes(raw.category) && typeof raw.subject === 'string' && typeof raw.message === 'string') return raw
  } catch { /* Storage may be unavailable; the page remains usable. */ }
  return fresh()
}

export function Feedback() {
  const [draft, setDraft] = useState(initialDraft)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [followUp, setFollowUp] = useState({ id: crypto.randomUUID(), message: '' })

  async function readTicket() {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/feedback/${draft.id}`, { cache: 'no-store', headers: { Authorization: `Bearer ${draft.accessToken}` }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(response.status === 404 ? 'No report is available for this private link. It may have expired or been deleted.' : 'Could not refresh. Please try again.')
      const data = await response.json() as { ticket: Ticket }
      setTicket(data.ticket)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not refresh.') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/feedback/config', { cache: 'no-store', signal: controller.signal })
      .then(async response => setReady(response.ok && (await response.json() as { enabled?: boolean }).enabled === true))
      .catch(() => { if (!controller.signal.aborted) setReady(false) })
    let previouslyReceived = false
    try { previouslyReceived = sessionStorage.getItem(`${DRAFT_KEY}.received`) === draft.id } catch { /* Optional restoration. */ }
    if (window.location.hash.slice(1) === `${draft.id}.${draft.accessToken}` || previouslyReceived) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
      void readTicket()
    }
    return () => controller.abort()
  }, [])
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); setStorageUnavailable(false) }
    catch { setStorageUnavailable(true) }
  }, [draft])

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft), signal: AbortSignal.timeout(15_000) })
      const data = await response.json() as { ticket?: Ticket; error?: string }
      if (!response.ok || !data.ticket) throw new Error(data.error ?? 'Your report was not accepted.')
      setTicket(data.ticket)
      try { sessionStorage.setItem(`${DRAFT_KEY}.received`, draft.id) } catch { /* Save the private link when storage is unavailable. */ }
    } catch (err) { setError(err instanceof Error && err.name !== 'TimeoutError' ? err.message : 'No confirmation received. Keep this page open and retry with the same draft; a retry will not create a duplicate.') }
    finally { setBusy(false) }
  }

  async function copyLink() {
    try {
      const url = new URL(window.location.href)
      url.hash = `${draft.id}.${draft.accessToken}`
      await navigator.clipboard.writeText(url.href)
      setNotice('Private link copied. Keep it somewhere safe; anyone with it can read or delete this report.')
    } catch { setError('Clipboard access was denied. Allow clipboard access in your browser and try again.') }
  }

  async function remove() {
    if (!window.confirm('Permanently delete this support report and its reply?')) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/feedback/${draft.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${draft.accessToken}` }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error('Deletion was not confirmed. Please retry.')
      setTicket(null); setDraft(fresh()); setNotice('Report deleted.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Deletion was not confirmed.') }
    finally { setBusy(false) }
  }

  async function sendFollowUp(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(`/api/feedback/${draft.id}/messages`, { method: 'POST',
        headers: { Authorization: `Bearer ${draft.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...followUp, accessToken: draft.accessToken }), signal: AbortSignal.timeout(15_000) })
      const data = await response.json() as { ticket?: Ticket; error?: string }
      if (!response.ok || !data.ticket) throw new Error(data.error ?? 'Your follow-up was not accepted.')
      setTicket(data.ticket); setFollowUp({ id: crypto.randomUUID(), message: '' }); setNotice('Follow-up received.')
    } catch (err) { setError(err instanceof Error && err.name !== 'TimeoutError' ? err.message :
      'No confirmation received. Retry without changing this message; the same follow-up will not be duplicated.') }
    finally { setBusy(false) }
  }

  return <main id="main" className="feedback-page">
    <a className="feedback-back" href={siteHref('/')}><ArrowLeft size={16} aria-hidden="true" /> Back to LongLeash</a>
    <header className="feedback-heading">
      <p className="eyebrow">A direct line</p>
      <h1>Tell us what got in your way.</h1>
      <p>A bug, an idea, or a question. Your report goes privately to the person building LongLeash.</p>
    </header>
    <div className="feedback-layout">
      <section className="feedback-panel" aria-label={ticket ? 'Your private report' : 'Send feedback'}>
        {ticket ? <>
          <p className="feedback-received"><CheckCircle2 size={20} aria-hidden="true" /> Report received</p>
          <h2>{ticket.subject}</h2>
          <p className="feedback-meta">{ticket.status.replaceAll('_', ' ')} · Updated {new Date(ticket.updated_at).toLocaleString()}</p>
          <div className="feedback-thread" aria-label="Private conversation">
            {(ticket.messages ?? []).map(item => <article className={`feedback-message-card ${item.author}`} key={item.id}>
              <header><strong>{item.author === 'owner' ? 'LongLeash' : 'You'}</strong><time dateTime={new Date(item.created_at).toISOString()}>{new Date(item.created_at).toLocaleString()}</time></header>
              <p>{item.body}</p><small>{item.status_snapshot.replaceAll('_', ' ')}</small>
            </article>)}
            {(ticket.messages ?? []).every(item => item.author !== 'owner') && <p className="feedback-meta">No reply yet. Save your private link and check back here.</p>}
          </div>
          <form className="feedback-followup" onSubmit={event => void sendFollowUp(event)}>
            <label htmlFor="feedback-followup">Add a follow-up</label>
            <textarea id="feedback-followup" required maxLength={4000} rows={4} disabled={busy}
              value={followUp.message} onChange={event => setFollowUp({ ...followUp, message: event.target.value })}
              placeholder="Add context or answer a question. Leave out code, credentials, and private project details." />
            <button className="key sm" type="submit" disabled={busy || !followUp.message.trim()}><Send size={16} aria-hidden="true" /> Send follow-up</button>
          </form>
          <p className="feedback-meta">{ticket.expires_at === null
            ? 'This report remains available until you delete it or for 90 days after it is closed.'
            : `This closed report is available until ${new Date(ticket.expires_at).toLocaleDateString()}.`} Keep your link private.</p>
          <div className="feedback-actions">
            <button className="key" disabled={busy} onClick={() => void copyLink()}><Copy size={16} aria-hidden="true" /> Copy private link</button>
            <button className="key" disabled={busy} onClick={() => void readTicket()}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
          </div>
          <div className="feedback-actions">
            <button className="key sm" disabled={busy} onClick={() => { if (window.confirm('Save your private link first. Start a new report?')) { setTicket(null); setDraft(fresh()); setNotice('') } }}>New report</button>
            <button className="key sm danger" disabled={busy} onClick={() => void remove()}>Delete report</button>
          </div>
        </> : <form onSubmit={event => void submit(event)}>
          {ready === false && <div><p role="status">The web inbox is unavailable. You can email support below; this check has not submitted your draft.</p><button type="button" className="key sm" onClick={() => window.location.reload()}>Check again</button></div>}
          <label htmlFor="feedback-kind">What can we help with?</label>
          <select id="feedback-kind" disabled={busy} value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}>
            <option value="bug">Report a bug</option><option value="feature">Request a feature</option><option value="help">Ask for help</option>
          </select>
          <label htmlFor="feedback-subject">Short summary</label>
          <input id="feedback-subject" required maxLength={120} disabled={busy} value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })} placeholder="What were you trying to do?" />
          <label htmlFor="feedback-message">Details</label>
          <textarea id="feedback-message" required maxLength={4000} rows={8} disabled={busy} value={draft.message} onChange={event => setDraft({ ...draft, message: event.target.value })} aria-describedby="feedback-safety" placeholder="What happened, and what did you expect? Please leave out private project details." />
          <p id="feedback-safety" className="feedback-meta">Do not paste code, transcripts, passwords, or pairing links. {draft.message.length.toLocaleString()} / 4,000 characters.</p>
          <p className="feedback-meta">{storageUnavailable ? 'Browser draft storage is unavailable. Keep this page open.' : 'Your draft stays in this browser tab until you send it.'} Reports are private, deletable using your private link, and retained until closure plus 90 days.</p>
          <button className="key feedback-submit" disabled={busy || ready !== true || !draft.subject.trim() || !draft.message.trim()} type="submit"><Send size={18} aria-hidden="true" /> {busy ? 'Waiting for confirmation…' : 'Send private report'}</button>
        </form>}
        {error && <p className="feedback-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
      <aside className="feedback-aside">
        <MessageSquare size={25} aria-hidden="true" /><h2>A conversation, not a public comment.</h2>
        <p>No signup is needed to report a sign-in problem. The web inbox returns a private link where you can read the founder’s reply.</p>
        <p>Prefer email? <a href="mailto:support@longleash.dev">support@longleash.dev</a></p>
        <ShieldCheck size={23} aria-hidden="true" /><h3>Found a security issue?</h3>
        <p>Use <a href="mailto:security@longleash.dev">security@longleash.dev</a>. Never publish credentials or exploit details in a public issue.</p>
        <a href={siteHref('/privacy')}>How support data is handled</a>
      </aside>
    </div>
  </main>
}
