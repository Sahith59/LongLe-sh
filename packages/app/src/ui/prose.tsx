import { Fragment, type ReactNode } from 'react'

/**
 * Agent replies are markdown whether we like it or not: recaps arrive as bullet lists, run
 * instructions as fenced commands, follow-ups as numbered steps. Rendering that as raw text
 * is what made the phone transcript look broken. This is the smallest structured reader that
 * covers what agents actually emit — paragraphs, lists, fences, headings, inline code/bold —
 * parsed with plain string handling so a malformed reply degrades to text, never to a crash.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  /** Bold carries children, because agents write **`/a/path`** and the backticks must
      still become a code chip instead of leaking into the reader's face. */
  | { t: 'strong'; inline: Inline[] }

export type ProseBlock =
  | { t: 'p'; inline: Inline[] }
  | { t: 'heading'; inline: Inline[] }
  | { t: 'bullets'; items: Inline[][] }
  | { t: 'numbered'; start: number; items: Inline[][] }
  | { t: 'fence'; lang: string; code: string }

const BULLET = /^\s{0,6}[-*•]\s+(.*)$/
const NUMBERED = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/
const HEADING = /^#{1,4}\s+(.*)$/
const FENCE = /^\s{0,3}```([\w+-]*)\s*$/

function splitCode(text: string): Inline[] {
  const out: Inline[] = []
  for (const part of text.split(/(`[^`]+`)/g)) {
    if (part.length === 0) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push({ t: 'code', text: part.slice(1, -1) })
    } else {
      out.push({ t: 'text', text: part })
    }
  }
  return out
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (part.length === 0) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push({ t: 'strong', inline: splitCode(part.slice(2, -2)) })
    } else {
      out.push(...splitCode(part))
    }
  }
  return out
}

export function parseProse(text: string): ProseBlock[] {
  const lines = text.split('\n')
  const blocks: ProseBlock[] = []
  let paragraph: string[] = []

  const flush = () => {
    const joined = paragraph.join('\n').trim()
    paragraph = []
    if (joined.length > 0) blocks.push({ t: 'p', inline: parseInline(joined) })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string

    const fence = line.match(FENCE)
    if (fence) {
      flush()
      const code: string[] = []
      let closed = false
      while (++i < lines.length) {
        if (/^\s{0,3}```\s*$/.test(lines[i] as string)) {
          closed = true
          break
        }
        code.push(lines[i] as string)
      }
      // Streaming sends the fence before its close; showing it as code already is correct.
      void closed
      blocks.push({ t: 'fence', lang: fence[1] ?? '', code: code.join('\n') })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      flush()
      blocks.push({ t: 'heading', inline: parseInline((heading[1] ?? '').trim()) })
      continue
    }

    const bullet = line.match(BULLET)
    if (bullet) {
      flush()
      const last = blocks[blocks.length - 1]
      const item = parseInline((bullet[1] ?? '').trim())
      if (last?.t === 'bullets') last.items.push(item)
      else blocks.push({ t: 'bullets', items: [item] })
      continue
    }

    const numbered = line.match(NUMBERED)
    if (numbered) {
      flush()
      const last = blocks[blocks.length - 1]
      const item = parseInline((numbered[2] ?? '').trim())
      if (last?.t === 'numbered') last.items.push(item)
      else blocks.push({ t: 'numbered', start: parseInt(numbered[1] ?? '1', 10), items: [item] })
      continue
    }

    if (line.trim().length === 0) {
      flush()
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

function InlineRun({ inline }: { inline: Inline[] }) {
  return (
    <>
      {inline.map((piece, i) =>
        piece.t === 'code' ? (
          <code key={i}>{piece.text}</code>
        ) : piece.t === 'strong' ? (
          <strong key={i}>
            <InlineRun inline={piece.inline} />
          </strong>
        ) : (
          <Fragment key={i}>{piece.text}</Fragment>
        ),
      )}
    </>
  )
}

export function Prose({ text }: { text: string }): ReactNode {
  const blocks = parseProse(text)
  return (
    <>
      {blocks.map((block, i) => {
        if (block.t === 'fence') {
          return (
            <pre key={i} className="fence">
              {block.lang ? <span className="lang">{block.lang}</span> : null}
              <code>{block.code}</code>
            </pre>
          )
        }
        if (block.t === 'heading') {
          return (
            <p key={i} className="h">
              <InlineRun inline={block.inline} />
            </p>
          )
        }
        if (block.t === 'bullets') {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <InlineRun inline={item} />
                </li>
              ))}
            </ul>
          )
        }
        if (block.t === 'numbered') {
          return (
            <ol key={i} start={block.start}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <InlineRun inline={item} />
                </li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i} className="para">
            <InlineRun inline={block.inline} />
          </p>
        )
      })}
    </>
  )
}
