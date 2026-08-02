import { motion } from 'motion/react'
import type { Block } from '../lib/store.js'
import { EASE } from './primitives.js'
import { splitTool, toolIcon } from './format.js'
import { Prose } from './prose.js'

/**
 * Renders each piece of the conversation as what it actually is. Agent prose reads as prose,
 * tool calls stay compact and auditable without burying the answer, and your own messages sit
 * apart. Flattening all three into one monospace block made the transcript unreadable on a
 * phone — that was the single worst thing about the old UI.
 */
export function TranscriptBlock({ block }: { block: Block }) {
  if (block.kind === 'tool') {
    const { name, detail } = splitTool(block.text)
    const Glyph = toolIcon(name)
    return (
      <motion.div
        className="blk tool"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={EASE}
        title={block.text}
      >
        <Glyph size={14} strokeWidth={2} aria-hidden="true" />
        <span className="tname">{name}</span>
        {detail ? (
          <span className="targ">{detail}</span>
        ) : null}
      </motion.div>
    )
  }

  if (block.kind === 'user') {
    const text = block.text.replace(/^[\s›]+/, '').trim()
    if (text === '— reopened —') return <div className="blk divider">reopened</div>
    return (
      <motion.div
        className="blk mine"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={EASE}
      >
        {text}
      </motion.div>
    )
  }

  if (block.kind === 'thinking') {
    return <div className="blk thinking">{block.text.trim()}</div>
  }

  return (
    <motion.div
      className="blk say"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={EASE}
    >
      <Prose text={block.text} />
    </motion.div>
  )
}
