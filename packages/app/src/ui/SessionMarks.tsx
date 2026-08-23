import { useId, type ComponentType } from 'react'
import { AGENT_LABEL, ORIGIN_LABEL } from './format.js'

type IconProps = { className?: string }

function usePaintId(prefix: string) {
  return `${prefix}-${useId().replace(/:/g, '')}`
}

/**
 * Provider and surface identities are deliberately drawn here as small SVG app
 * tiles. At session-card size a generic outline glyph loses its identity; these
 * retain each product's silhouette, native colour and material without loading
 * raster assets or another icon package.
 */
function ClaudeIcon({ className }: IconProps) {
  const coral = usePaintId('claude-coral')
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={coral} x1="5" y1="3" x2="27" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#df7c5d" />
          <stop offset="1" stopColor="#c95e43" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.4" fill={`url(#${coral})`} />
      <path d="M3.5 3.2h25" stroke="#fff" strokeOpacity=".14" strokeLinecap="round" />
      <g fill="none" stroke="#fff" strokeWidth="3.25" strokeLinecap="round">
        <path d="M16 5.1v6.2" />
        <path d="m22.2 6.8-3.1 5.2" />
        <path d="m26.6 11.7-5.7 2.7" />
        <path d="m27 18-6.1-1" />
        <path d="m23.5 24.7-4.4-5" />
        <path d="m16.8 27-.6-6.1" />
        <path d="m9.9 25.6 3.2-5.4" />
        <path d="m5.2 20.8 5.9-2.5" />
        <path d="m5.1 13.9 6 1.2" />
        <path d="m8.7 7.9 4.2 4.7" />
      </g>
      <circle cx="16" cy="16.1" r="3.45" fill="#fff" />
    </svg>
  )
}

function CodexIcon({ className }: IconProps) {
  const cloud = usePaintId('codex-cloud')
  const porcelain = usePaintId('codex-porcelain')
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={porcelain} x1="4" y1="2" x2="27" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#e9eaf0" />
        </linearGradient>
        <linearGradient id={cloud} x1="8" y1="7" x2="24" y2="25" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b9a6ff" />
          <stop offset=".48" stopColor="#647dff" />
          <stop offset="1" stopColor="#303df0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.4" fill={`url(#${porcelain})`} />
      <path
        d="M9.1 23.8c-3 0-5.3-2.25-5.3-5.04 0-2.35 1.55-4.3 3.78-4.88C7.45 9.98 10.42 7 14.18 7c2.81 0 5.2 1.66 6.28 4.03.45-.15.94-.23 1.45-.23 2.65 0 4.8 2.07 4.8 4.63 0 .42-.06.82-.17 1.2 1.08.7 1.78 1.9 1.78 3.27 0 2.16-1.82 3.9-4.07 3.9Z"
        fill={`url(#${cloud})`}
      />
      <path d="M7.9 15.6c.35-3.42 2.8-6.4 6.4-7.06" fill="none" stroke="#fff" strokeOpacity=".32" strokeWidth="1.1" strokeLinecap="round" />
      <path d="m11.35 14.45 2.55 2.45-2.55 2.45" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 19.35h4.45" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

function VSCodeIcon({ className }: IconProps) {
  const tile = usePaintId('vscode-tile')
  const blue = usePaintId('vscode-blue')
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={tile} x1="3" y1="2" x2="29" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f7f8fa" />
          <stop offset="1" stopColor="#dfe4e9" />
        </linearGradient>
        <linearGradient id={blue} x1="8" y1="8" x2="25" y2="25" gradientUnits="userSpaceOnUse">
          <stop stopColor="#28a8ea" />
          <stop offset="1" stopColor="#0879c9" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.4" fill={`url(#${tile})`} />
      <path d="m7.35 10.2 5.2 4.25L22.7 5.3a1.7 1.7 0 0 1 1.76-.3l2.63 1.25c.56.27.91.83.91 1.45v16.6c0 .62-.35 1.18-.91 1.45L24.46 27a1.7 1.7 0 0 1-1.76-.3l-10.15-9.15-5.2 4.25a1.05 1.05 0 0 1-1.4-.06l-1.62-1.5a1 1 0 0 1 .01-1.49L7.72 16l-3.38-2.75a1 1 0 0 1-.01-1.49l1.62-1.5a1.05 1.05 0 0 1 1.4-.06Z" fill={`url(#${blue})`} />
      <path d="M22.74 9.9 14.42 16l8.32 6.1Z" fill="#0875bd" />
      <path d="m7.35 10.2 5.2 4.25 1.87 1.55-1.87 1.55-5.2 4.25" fill="none" stroke="#31b4f2" strokeWidth="1.05" strokeLinejoin="round" />
      <path d="M23.2 5.08v21.84" stroke="#fff" strokeOpacity=".17" strokeWidth=".8" />
    </svg>
  )
}

function TerminalIcon({ className }: IconProps) {
  const shell = usePaintId('terminal-shell')
  const chrome = usePaintId('terminal-chrome')
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={shell} x1="4" y1="2" x2="27" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#343536" />
          <stop offset=".38" stopColor="#1e1f20" />
          <stop offset="1" stopColor="#0b0b0c" />
        </linearGradient>
        <linearGradient id={chrome} x1="10" y1="10" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" />
          <stop offset=".52" stopColor="#d4d5d7" />
          <stop offset="1" stopColor="#888a8e" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.4" fill={`url(#${shell})`} stroke="#56585c" strokeWidth=".55" />
      <path d="M5.2 4.1c4-2.25 17.1-2.3 21.5.1" fill="none" stroke="#fff" strokeOpacity=".11" strokeLinecap="round" />
      <path d="m9.15 11.1 5.1 4.9-5.1 4.9" fill="none" stroke={`url(#${chrome})`} strokeWidth="2.65" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.15 21h6.25" fill="none" stroke={`url(#${chrome})`} strokeWidth="2.65" strokeLinecap="round" />
    </svg>
  )
}

function PhoneIcon({ className }: IconProps) {
  const shell = usePaintId('phone-shell')
  const screen = usePaintId('phone-screen')
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={shell} x1="4" y1="2" x2="27" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#36383c" />
          <stop offset="1" stopColor="#111215" />
        </linearGradient>
        <linearGradient id={screen} x1="12" y1="8" x2="20" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1c2326" />
          <stop offset="1" stopColor="#090b0d" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.4" fill={`url(#${shell})`} stroke="#55585f" strokeWidth=".55" />
      <rect x="10.35" y="5.15" width="11.3" height="21.7" rx="3.2" fill="#aeb1b7" />
      <rect x="11.55" y="6.35" width="8.9" height="19.3" rx="2.25" fill={`url(#${screen})`} />
      <path d="M14.15 8h3.7" stroke="#8c9096" strokeWidth=".8" strokeLinecap="round" />
      <circle cx="16" cy="22.9" r="1.2" fill="#8fc5a5" />
      <path d="M13.45 17.7a3.6 3.6 0 0 1 5.1 0M14.65 19a1.92 1.92 0 0 1 2.7 0" fill="none" stroke="#a9d1ba" strokeWidth=".85" strokeLinecap="round" />
      <circle cx="16" cy="20.25" r=".62" fill="#c7e4d2" />
    </svg>
  )
}

function LaptopIcon({ className }: IconProps) {
  const shell = usePaintId('laptop-shell')
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={shell} x1="3" y1="2" x2="29" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#303238" />
          <stop offset="1" stopColor="#121316" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.4" fill={`url(#${shell})`} stroke="#4b4e55" strokeWidth=".55" />
      <rect x="7.3" y="7.7" width="17.4" height="12.8" rx="1.8" fill="#0a0b0d" stroke="#b0b3b9" strokeWidth="1.35" />
      <path d="M5.7 22.3h20.6l-1.55 2H7.25Z" fill="#a7aab0" />
      <path d="M14.05 22.35h3.9" stroke="#676a70" strokeWidth=".75" strokeLinecap="round" />
      <circle cx="21.65" cy="10.85" r="1.25" fill="#9dcbb0" />
    </svg>
  )
}

const providerIcons: Record<string, ComponentType<IconProps>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
}

const surfaceIcons: Record<string, ComponentType<IconProps>> = {
  terminal: TerminalIcon,
  vscode: VSCodeIcon,
  phone: PhoneIcon,
  daemon: LaptopIcon,
  external: LaptopIcon,
}

/** Compact graphical identity plates. The label remains available to assistive tech and Help. */
export function ProviderMark({ agent, decorative = false }: { agent: string; decorative?: boolean }) {
  const Icon = providerIcons[agent] ?? CodexIcon
  const label = AGENT_LABEL[agent] ?? agent
  return (
    <span
      className="identitymark providermark"
      data-agent={agent}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label, title: label })}
    >
      <Icon className="identityglyph" />
    </span>
  )
}

export function SurfaceMark({ origin }: { origin: string }) {
  const Icon = surfaceIcons[origin] ?? LaptopIcon
  const label = ORIGIN_LABEL[origin] ?? origin
  return (
    <span className="identitymark surfacemark" data-origin={origin} role="img" aria-label={label} title={label}>
      <Icon className="identityglyph" />
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
