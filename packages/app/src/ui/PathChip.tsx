import { File, Folder, Terminal } from 'lucide-react'

/**
 * A path is a thing, not a sentence. Left as bare text it disappears into
 * prose; given an icon, a surface and a monospace face it becomes something a
 * reader can pick out at a glance — which was the whole complaint about the
 * old transcript.
 *
 * Truncation happens in the MIDDLE for paths, because both ends carry meaning:
 * the project at the front, the file at the back. Chopping either one off is
 * how you end up with three rows that all read "…/src/components/".
 */
export function middleTruncate(text: string, max = 42): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export type ChipKind = 'folder' | 'file' | 'command'

export function PathChip({
  text,
  kind = 'file',
  accent,
  max,
}: {
  text: string
  kind?: ChipKind
  accent?: boolean
  max?: number
}) {
  const Glyph = kind === 'folder' ? Folder : kind === 'command' ? Terminal : File
  return (
    <span className={`pathchip${accent ? ' accent' : ''}`} title={text}>
      <Glyph size={12} strokeWidth={2} aria-hidden="true" />
      <span className="txt">{middleTruncate(text, max)}</span>
    </span>
  )
}
