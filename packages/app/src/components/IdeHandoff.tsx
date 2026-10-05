import { useState } from 'react'

export interface IdeHandoffProps {
  connected: boolean
  listWindows: () => Promise<{ windowId: string; label: string }[]>
  openWindow: (windowId: string) => Promise<void>
}

/** Success means the target extension acknowledged rendering this exact conversation. */
export function IdeHandoff({ connected, listWindows, openWindow }: IdeHandoffProps) {
  const [windows, setWindows] = useState<{ windowId: string; label: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const find = async () => {
    setBusy(true)
    setStatus('Finding connected VS Code windows…')
    try {
      const found = await listWindows()
      setWindows(found)
      setStatus(found.length ? 'Choose where to open this conversation.' : 'Open this project in a trusted VS Code window with the LongLeash extension and laptop service running, then try again.')
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not reach VS Code.') }
    finally { setBusy(false) }
  }
  const open = async (windowId: string) => {
    setBusy(true)
    setStatus('Waiting for VS Code to open this conversation…')
    try { await openWindow(windowId); setStatus('Opened this exact conversation in the LongLeash editor in VS Code.'); setWindows([]) }
    catch (error) { setStatus(error instanceof Error ? error.message : 'VS Code did not confirm opening.') }
    finally { setBusy(false) }
  }
  return <section className="ide-handoff" aria-label="VS Code handoff">
    <button type="button" className="key sm" disabled={!connected || busy} onClick={() => { void find() }}>Open in VS Code</button>
    {status ? <p role="status">{status}</p> : null}
    {windows.map((window, index) => <button type="button" className="key sm" key={window.windowId} disabled={!connected || busy} onClick={() => { void open(window.windowId) }}>
      {window.label}{windows.filter((candidate) => candidate.label === window.label).length > 1 ? ` · Window ${index + 1}` : ''}
    </button>)}
  </section>
}
