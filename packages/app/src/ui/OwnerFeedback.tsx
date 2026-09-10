import { useEffect, useState } from 'react'
import { ArrowLeft, Inbox, RefreshCw } from 'lucide-react'
import '../landing/feedback.css'

type Ticket = { id: string; subject: string; message: string; category: string; status: string; reply: string; revision: number; created_at: number }

export default function OwnerFeedback({ getToken }: { getToken: () => Promise<string | null> }) {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<Ticket | null>(null)
  const [reply, setReply] = useState('')
  const [status, setStatus] = useState('received')
  const [notice, setNotice] = useState('')

  async function api(path: string, init: RequestInit = {}) {
    const token = await getToken()
    if (!token) throw new Error('Please sign in again.')
    const response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    } })
    if (response.status === 403) throw new Error('Owner access requires the configured owner account and a first- and second-factor verification within the last 10 minutes. Sign in again with your authenticator, then refresh. A normal Google sign-in alone does not meet this requirement.')
    const data = await response.json()
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Request failed. Please retry.')
    return data
  }
  async function load(nextPage: number) {
    setBusy(true); setError(''); setLoaded(false); setTickets([]); setSelected(null)
    try {
      const data = await api(`/api/owner/feedback?page=${nextPage}`) as { tickets: Ticket[]; hasMore: boolean }
      setTickets(data.tickets); setHasMore(data.hasMore); setPage(nextPage); setLoaded(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to open the inbox.') }
    finally { setBusy(false) }
  }
  useEffect(() => { void load(0) }, [])
  async function save() {
    if (!selected) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api(`/api/owner/feedback/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ reply, status, revision: selected.revision }) })
      await load(page); setNotice('Reply saved to the private report. No email was sent.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Reply was not saved.') }
    finally { setBusy(false) }
  }
  return <main className="feedback-page">
    <a className="feedback-back" href="/"><ArrowLeft size={16} aria-hidden="true" /> Back to sessions</a>
    <header className="feedback-heading"><p className="eyebrow">Owner workspace</p><h1>Customer inbox.</h1><p>Private reports, direct replies. Access is checked on the server for every request and requires recent multi-factor verification.</p></header>
    <button className="key" onClick={() => void load(page)} disabled={busy}><RefreshCw size={16} aria-hidden="true" /> Refresh inbox</button>
    {error && <p className="feedback-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">Loading…</p>}
    {loaded && tickets.length === 0 && <section className="feedback-panel"><Inbox size={24} aria-hidden="true" /><h2>No reports on this page.</h2><p>New feedback will appear here. This is not a measure of registered users.</p></section>}
    <div className="feedback-layout" style={{ marginTop: 24 }}>
      <section aria-label="Reports">{tickets.map(ticket => <button key={ticket.id} className="feedback-ticket key" disabled={busy} onClick={() => { setSelected(ticket); setReply(ticket.reply); setStatus(ticket.status); setNotice('') }}>
        <strong>{ticket.subject}</strong><small>{ticket.category} · {ticket.status.replaceAll('_', ' ')} · {new Date(ticket.created_at).toLocaleDateString()}</small>
      </button>)}
      {loaded && <div className="feedback-actions"><button className="key sm" disabled={busy || page === 0} onClick={() => void load(page - 1)}>Previous</button><span>Page {page + 1}</span><button className="key sm" disabled={busy || !hasMore} onClick={() => void load(page + 1)}>Next</button></div>}
      </section>
      {selected && <form className="feedback-panel" onSubmit={event => { event.preventDefault(); void save() }}>
        <h2>{selected.subject}</h2><p className="feedback-message">{selected.message}</p>
        <label htmlFor="owner-status">Status</label><select id="owner-status" value={status} onChange={event => setStatus(event.target.value)} disabled={busy}>
          {['received', 'needs_information', 'planned', 'resolved', 'not_planned'].map(value => <option value={value} key={value}>{value.replaceAll('_', ' ')}</option>)}
        </select>
        <label htmlFor="owner-reply">Reply on the private report</label><textarea id="owner-reply" maxLength={4000} required value={reply} rows={6} disabled={busy} onChange={event => setReply(event.target.value)} />
        <p className="feedback-meta">The user can read this at their private link. Email notifications are not enabled.</p>
        <button className="key" type="submit" disabled={busy || !reply.trim()}>Save reply</button>
      </form>}
    </div>
  </main>
}
