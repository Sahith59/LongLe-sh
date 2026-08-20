/**
 * Service logs are durable and may be collected by support tooling. Keep enough lifecycle
 * evidence to diagnose health while failing closed on prompts, code, paths, provider frames,
 * pairing material, environment values, and arbitrary exception text.
 */
export function persistentServiceLogLine(line: string): string | null {
  if (/codex\s+(?:<-|->)/i.test(line)) return null
  const stamp = line.match(/^\[[^\]]+\]\s*/)?.[0] ?? ''
  const message = line.slice(stamp.length)

  const started = message.match(/^(claude|codex) session ([A-Za-z0-9_-]{1,32}) started in .+ \((terminal|vscode|phone)\)$/i)
  if (started) return `${stamp}${started[1]!.toLowerCase()} session ${started[2]} started (${started[3]!.toLowerCase()})`
  if (/^\? .+ in [A-Za-z0-9_-]+ .* -> /i.test(message)) return `${stamp}tool decision recorded`
  if (/^(decision|gate|resume|takeOver|stop|session)\s/i.test(message)) return `${stamp}session lifecycle state changed`
  if (/^(delegation|start) refused:/i.test(message)) return `${stamp}session request refused; details are available on the paired device`
  if (/^(relay|relay link|relay room|dropped a relay frame)/i.test(message)) return `${stamp}relay connection state changed`
  if (/^(device|dropping unresponsive connection)/i.test(message)) return `${stamp}device connection state changed`
  if (/^push:/i.test(message) || /^push (subscription|test)/i.test(message)) return `${stamp}push delivery state changed`
  if (/^(keeping this Mac awake|all agents idle)/i.test(message)) return `${stamp}${message}`
  if (/^rebound to /i.test(message)) return `${stamp}local listener rebound`

  return `${stamp}service activity recorded; details omitted`
}
