import { useState } from 'react'
import { File, Folder, Terminal } from 'lucide-react'

/**
 * A path is a thing, not a sentence: icon, monospace, its own surface. Truncated in the
 * MIDDLE because both ends carry meaning — the project at the front, the file at the back.
 *
 * Tappable where the layout allows it: one tap unfolds the full path in place, tap again to
 * fold it back. Inside a card that is itself a button (the session list) nesting a second
 * button is invalid HTML and an accessibility trap, so there the chip stays inert and the
 * full path lives in the title attribute.
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
  expandable,
}: {
  text: string
  kind?: ChipKind
  accent?: boolean
  max?: number
  /** Offer tap-to-unfold. Only valid where the chip is not nested inside another button. */
  expandable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const Glyph = kind === 'folder' ? Folder : kind === 'command' ? Terminal : File
  const truncated = middleTruncate(text, max)
  const canExpand = expandable === true && truncated !== text

  const body = (
    <>
      <Glyph size={12} strokeWidth={2} aria-hidden="true" />
      <span className="txt">{open ? text : truncated}</span>
    </>
  )

  if (!canExpand) {
    return (
      <span className={`pathchip${accent ? ' accent' : ''}`} title={text}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`pathchip tappable${accent ? ' accent' : ''}${open ? ' open' : ''}`}
      aria-expanded={open}
      aria-label={open ? `Collapse path ${text}` : `Show full path ${text}`}
      onClick={(event) => {
        event.stopPropagation()
        setOpen((value) => !value)
      }}
    >
      {body}
    </button>
  )
}
