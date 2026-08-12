import { humanSaid } from '@longleash/protocol'
import { GitBranchPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Block } from '../lib/store.js'
import { splitTool, toolIcon } from './format.js'
import { PathChip } from './PathChip.js'
import { Prose } from './prose.js'

/**
 * The conversation, rendered as a conversation.
 *
 * The rule that makes it readable: consecutive tool calls collapse into ONE
 * action group with a shared spine, instead of N identical grey lines. An
 * agent that reads six files then answers should look like "it did some work,
 * then said this" — not like a log file with a sentence buried in it.
 */
export function Transcript({
  blocks,
  onDelegate,
}: {
  blocks: Block[]
  onDelegate?: (block: Block) => void
}) {
  const groups = groupBlocks(blocks)
  return (
    <>
      {groups.map((group, i) =>
        group.kind === 'actions' ? (
          <ActionGroup key={i} items={group.items} />
        ) : (
          <TranscriptBlock key={i} block={group.block} {...(onDelegate ? { onDelegate } : {})} />
        ),
      )}
    </>
  )
}

type Group = { kind: 'actions'; items: string[] } | { kind: 'block'; block: Block }

/** Consecutive tool calls belong together; everything else stands alone. */
function groupBlocks(blocks: Block[]): Group[] {
  const groups: Group[] = []
  for (const block of blocks) {
    const last = groups[groups.length - 1]
    if (block.kind === 'tool') {
      if (last?.kind === 'actions') last.items.push(block.text)
      else groups.push({ kind: 'actions', items: [block.text] })
    } else {
      groups.push({ kind: 'block', block })
    }
  }
  return groups
}

function ActionGroup({ items }: { items: string[] }) {
  return (
    <div className="actions">
      {items.map((text, i) => {
        const { name, detail } = splitTool(text)
        const Glyph = toolIcon(name)
        // A shell command is not a path; showing it with a file icon would lie.
        const isCommand = name === 'Bash' || name === 'BashOutput'
        return (
          <div className="action" key={i} title={text}>
            <span className="ico">
              <Glyph size={13} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="verb">{name}</span>
            {detail ? (
              <PathChip text={detail} kind={isCommand ? 'command' : 'file'} max={38} expandable />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function TranscriptBlock({
  block,
  onDelegate,
}: {
  block: Block
  onDelegate?: (block: Block) => void
}) {
  if (block.kind === 'user') {
    // Also clean at render time: event-log history written by an older daemon may already
    // contain Codex's IDE envelope. A release should repair what the person sees now rather
    // than only making the next message clean.
    const text = humanSaid(block.text.replace(/^[\s›]+/, '')).trim()
    if (text === '') return null
    if (text === '— reopened —') return <div className="blk divider">reopened</div>
    return (
      <Delegatable block={block} {...(onDelegate ? { onDelegate } : {})}>
        <div className="blk mine">{text}</div>
      </Delegatable>
    )
  }

  if (block.kind === 'thinking') {
    return <div className="blk thinking">{block.text.trim()}</div>
  }

  return (
    <Delegatable block={block} {...(onDelegate ? { onDelegate } : {})}>
      <div className="blk say"><Prose text={block.text} /></div>
    </Delegatable>
  )
}

function Delegatable({
  block,
  onDelegate,
  children,
}: {
  block: Block
  onDelegate?: (block: Block) => void
  children: ReactNode
}) {
  if (!onDelegate) return children
  return (
    <div className={`blk-wrap ${block.kind}`}>
      {children}
      <button
        type="button"
        className="delegate-block"
        onClick={() => onDelegate(block)}
        aria-label={`Delegate ${block.kind === 'user' ? 'this user message' : 'this agent response'}`}
      >
        <GitBranchPlus size={15} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  )
}
