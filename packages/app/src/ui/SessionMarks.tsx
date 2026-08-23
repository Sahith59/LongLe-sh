import {
  Asterisk,
  Braces,
  Laptop,
  PanelsTopLeft,
  Smartphone,
  SquareTerminal,
} from 'lucide-react'
import { AGENT_LABEL, ORIGIN_LABEL } from './format.js'

const providerIcons = {
  claude: Asterisk,
  codex: Braces,
} as const

const surfaceIcons = {
  terminal: SquareTerminal,
  vscode: PanelsTopLeft,
  phone: Smartphone,
  daemon: Laptop,
  external: Laptop,
} as const

/** Compact graphical identity plates. The label remains available to assistive tech and Help. */
export function ProviderMark({ agent }: { agent: string }) {
  const Icon = providerIcons[agent as keyof typeof providerIcons] ?? Braces
  const label = AGENT_LABEL[agent] ?? agent
  return (
    <span className="identitymark providermark" data-agent={agent} role="img" aria-label={label} title={label}>
      <Icon size={15} strokeWidth={2.15} aria-hidden="true" />
    </span>
  )
}

export function SurfaceMark({ origin }: { origin: string }) {
  const Icon = surfaceIcons[origin as keyof typeof surfaceIcons] ?? Laptop
  const label = ORIGIN_LABEL[origin] ?? origin
  return (
    <span className="identitymark surfacemark" data-origin={origin} role="img" aria-label={label} title={label}>
      <Icon size={15} strokeWidth={2.05} aria-hidden="true" />
    </span>
  )
}

export function IdentityLegend() {
  return (
    <div className="identitylegend" aria-label="Session icon legend">
      <span><ProviderMark agent="claude" /> Claude</span>
      <span><ProviderMark agent="codex" /> Codex</span>
      <span><SurfaceMark origin="terminal" /> Terminal</span>
      <span><SurfaceMark origin="vscode" /> VS Code</span>
      <span><SurfaceMark origin="phone" /> Phone</span>
    </div>
  )
}
