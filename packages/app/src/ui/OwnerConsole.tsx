import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, BarChart3, Inbox, MailCheck, RefreshCw, Search, Users } from 'lucide-react'
import OwnerFeedback from './OwnerFeedback.js'
import '../landing/feedback.css'

type Token = () => Promise<string | null>

async function ownerApi(getToken: Token, path: string, init: RequestInit = {}) {
  const token = await getToken()
  if (!token) throw new Error('Please sign in again.')
  const response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: {
    Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  } })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (response.status === 403) throw new Error('Owner tools require the configured owner account and a recent authenticator verification. Open account security, verify both factors, then retry within 10 minutes.')
  if (!response.ok) throw new Error(data.error ?? 'The owner service is unavailable. No cached value was substituted.')
  return data
}

type Summary = {
  generatedAt: number
  accounts: { registered: number; external: number; owners: number; tests: number; newAccounts: number; activeAccounts: number }
  measurement: { state: 'not_measured' | 'measured'; consentedAccounts: number; pairedAccounts: number | null;
    activatedAccounts: number | null; weeklyActiveAccounts: number | null; repeatAccounts: number | null;
    outcomes: { success: number; failure: number; unknown: number } | null;
    actions: Record<string, { success: number; failure: number; unknown: number }> | null;
    retention: { d7: { eligible: number; retained: number } | null; d30: { eligible: number; retained: number } | null };
    window: { start: string; endExclusive: string } }
  feedback: { open: number; unanswered: number; byStatus: Record<string, number> }
  email: { state: string; deliveryState: string; count: number }[]
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return <article className="owner-metric"><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</article>
}

function Retention({ label, value }: { label: string; value: { eligible: number; retained: number } | null }) {
  return <Metric label={label} value={value ? `${Math.round(value.retained / value.eligible * 100)}%` : 'No eligible cohort'}
    detail={value ? `${value.retained} of ${value.eligible} eligible accounts returned on that exact UTC day` : 'Young cohorts are excluded, not counted as failures'} />
}

function OwnerOverview({ getToken }: { getToken: Token }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = async () => {
    setBusy(true); setError('')
    try { setSummary(await ownerApi(getToken, '/api/owner/summary') as Summary) }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to load the owner summary.') }
    finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])
  const testEmail = async () => {
    setBusy(true); setError(''); setNotice('')
    try { const result = await ownerApi(getToken, '/api/owner/email-test', { method: 'POST' }) as { detail?: string }; setNotice(result.detail ?? 'Email test queued.') }
    catch (err) { setError(err instanceof Error ? err.message : 'Email test was not queued.') }
    finally { setBusy(false) }
  }
  const delivered = summary?.email.filter(item => item.deliveryState === 'delivered').reduce((sum, item) => sum + item.count, 0) ?? 0
  const unconfirmed = summary?.email.filter(item => item.state === 'accepted' && item.deliveryState === 'unconfirmed').reduce((sum, item) => sum + item.count, 0) ?? 0
  return <>
    <div className="owner-toolbar"><button className="key sm" disabled={busy} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" /> Refresh evidence</button>
      <button className="key sm" disabled={busy} onClick={() => void testEmail()}><MailCheck size={16} aria-hidden="true" /> Send controlled email test</button></div>
    {error ? <p className="feedback-error" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {busy && !summary ? <p role="status">Loading current sources…</p> : null}
    {summary ? <div className="owner-sections">
      <section className="feedback-panel"><h2>Accounts</h2><p>Read live from Clerk Production. Owner and test accounts are excluded from external adoption.</p>
        <div className="owner-metrics"><Metric label="Registered" value={summary.accounts.registered} /><Metric label="External" value={summary.accounts.external} />
          <Metric label="New, last 7 days" value={summary.accounts.newAccounts} /><Metric label="Account-active, last 7 days" value={summary.accounts.activeAccounts} /></div></section>
      <section className="feedback-panel"><h2>Observed product use</h2><p>Only accounts that explicitly opted in. Browser acknowledgements are operational evidence, not billing records.</p>
        <div className="owner-metrics">{summary.measurement.state === 'not_measured' ? <Metric label="Coverage" value="Not measured" detail="No consenting account has produced an eligible sample" /> : <>
          <Metric label="Consenting" value={summary.measurement.consentedAccounts} /><Metric label="Paired" value={summary.measurement.pairedAccounts ?? 0} />
          <Metric label="Activated" value={summary.measurement.activatedAccounts ?? 0} /><Metric label="Weekly active" value={summary.measurement.weeklyActiveAccounts ?? 0} />
          <Metric label="Repeat" value={summary.measurement.repeatAccounts ?? 0} /><Retention label="D7 retention" value={summary.measurement.retention.d7} />
          <Retention label="D30 retention" value={summary.measurement.retention.d30} /></>}</div>
        {summary.measurement.actions && Object.keys(summary.measurement.actions).length > 0 ? <div className="owner-action-grid" role="table" aria-label="Observed action reliability">
          <div className="heading" role="row"><span role="columnheader">Action</span><span role="columnheader">Success</span><span role="columnheader">Failed</span><span role="columnheader">Unknown</span></div>
          {Object.entries(summary.measurement.actions).sort(([a], [b]) => a.localeCompare(b)).map(([action, outcomes]) => <div role="row" key={action}>
            <strong role="cell">{action}</strong><span role="cell">{outcomes.success}</span><span role="cell">{outcomes.failure}</span><span role="cell">{outcomes.unknown}</span>
          </div>)}
        </div> : null}
        <p className="feedback-meta">Window: {summary.measurement.window.start} to {summary.measurement.window.endExclusive} UTC, end exclusive.</p></section>
      <section className="feedback-panel"><h2>Customer inbox and delivery</h2><div className="owner-metrics"><Metric label="Open reports" value={summary.feedback.open} />
        <Metric label="Awaiting first reply" value={summary.feedback.unanswered} /><Metric label="Email delivered" value={delivered} detail="Verified Resend delivery webhook" />
        <Metric label="Accepted, unconfirmed" value={unconfirmed} detail="Provider accepted it; inbox delivery is not yet proven" /></div></section>
      <p className="feedback-meta">Generated {new Date(summary.generatedAt).toLocaleString()}. Missing sources fail visibly; the dashboard never substitutes stale values.</p>
    </div> : null}
  </>
}

type Account = { id: string; name: string | null; primaryEmail: string | null; emailVerified: boolean; createdAt: number;
  lastActiveAt: number | null; lastSignInAt: number | null; twoFactorEnabled: boolean; passwordEnabled: boolean;
  classification: 'owner' | 'test' | 'external' }
type AccountsPage = { users: Account[]; pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  totals: { registered: number; external: number; owners: number; tests: number } }

function OwnerAccounts({ getToken }: { getToken: Token }) {
  const [data, setData] = useState<AccountsPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async (nextOffset = offset, nextQuery = applied) => {
    setBusy(true); setError('')
    try { setData(await ownerApi(getToken, `/api/owner/accounts?offset=${nextOffset}&query=${encodeURIComponent(nextQuery)}`) as AccountsPage); setOffset(nextOffset); setApplied(nextQuery) }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to load accounts.') }
    finally { setBusy(false) }
  }
  useEffect(() => { void load(0, '') }, [])
  const search = (event: FormEvent) => { event.preventDefault(); void load(0, query.trim()) }
  return <section className="feedback-panel owner-account-panel"><div className="owner-account-heading"><div><h2>Registered accounts</h2><p>Live, paginated Clerk data. This view has no path to laptop sessions or transcripts.</p></div>
    <form className="owner-search" onSubmit={search}><label className="sr" htmlFor="owner-account-search">Search accounts</label><Search size={16} aria-hidden="true" />
      <input id="owner-account-search" maxLength={80} value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or email" /><button className="key sm" disabled={busy}>Search</button></form></div>
    {error ? <p className="feedback-error" role="alert">{error}</p> : null}
    {data ? <><div className="owner-metrics"><Metric label="Registered" value={data.totals.registered} /><Metric label="External" value={data.totals.external} />
      <Metric label="Owner" value={data.totals.owners} /><Metric label="Test" value={data.totals.tests} /></div>
      <div className="owner-account-list" role="table" aria-label="Clerk production accounts"><div className="owner-account-row heading" role="row"><span role="columnheader">Account</span><span role="columnheader">Classification</span><span role="columnheader">Joined</span><span role="columnheader">Last active</span></div>
        {data.users.map(user => <div className="owner-account-row" role="row" key={user.id}><span role="cell"><strong>{user.name ?? 'Unnamed account'}</strong><small>{user.primaryEmail ?? 'No primary email'} · {user.emailVerified ? 'verified' : 'unverified'}</small></span>
          <span role="cell"><mark className={`owner-class ${user.classification}`}>{user.classification}</mark></span><span role="cell">{new Date(user.createdAt).toLocaleDateString()}</span>
          <span role="cell">{user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : 'Never recorded'}</span></div>)}</div>
      <div className="feedback-actions"><button className="key sm" disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - 25))}>Previous</button>
        <span>{data.pagination.total === 0 ? 'No accounts' : `${offset + 1}–${Math.min(offset + data.users.length, data.pagination.total)} of ${data.pagination.total}`}</span>
        <button className="key sm" disabled={busy || !data.pagination.hasMore} onClick={() => void load(offset + 25)}>Next</button></div></> : busy ? <p role="status">Loading current accounts…</p> : null}
  </section>
}

export default function OwnerConsole({ getToken }: { getToken: Token }) {
  const path = window.location.pathname
  const view = path.endsWith('/feedback') ? 'feedback' : path.endsWith('/accounts') ? 'accounts' : 'overview'
  return <main className="feedback-page owner-console"><a className="feedback-back" href="/"><ArrowLeft size={16} aria-hidden="true" /> Back to sessions</a>
    <header className="feedback-heading"><p className="eyebrow">Owner workspace</p><h1>Customer operations.</h1><p>Current evidence from distinct sources, protected by server-side owner allowlisting and recent multi-factor verification.</p></header>
    <nav className="owner-nav" aria-label="Owner tools"><a className={view === 'overview' ? 'active' : ''} href="/owner"><BarChart3 size={17} aria-hidden="true" /> Overview</a>
      <a className={view === 'accounts' ? 'active' : ''} href="/owner/accounts"><Users size={17} aria-hidden="true" /> Accounts</a>
      <a className={view === 'feedback' ? 'active' : ''} href="/owner/feedback"><Inbox size={17} aria-hidden="true" /> Feedback</a></nav>
    {view === 'overview' ? <OwnerOverview getToken={getToken} /> : view === 'accounts' ? <OwnerAccounts getToken={getToken} /> : <OwnerFeedback getToken={getToken} />}
  </main>
}
