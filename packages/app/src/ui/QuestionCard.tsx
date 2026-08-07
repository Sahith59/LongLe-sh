import { useState } from 'react'
import { motion } from 'motion/react'
import { Check, MessageCircleQuestion, PenLine } from 'lucide-react'
import type { AskedQuestion } from '@longleash/protocol'
import type { PendingApproval } from '../lib/store.js'
import { EXIT, Key, SPRING } from './primitives.js'

/**
 * Claude is ASKING — not requesting permission.
 *
 * This surface is deliberately unlike the approval card. An approval is a gate you open
 * or shut; a question is a choice you make, and the two must never be answered by reflex
 * for one another. So: its own section label, its own sigil, options as pressable keys
 * that light up when chosen (luminance, the same language the whole interface speaks),
 * and one Send key that stays dark until every question has an answer.
 *
 * Nothing is pre-selected. A question answered by a stray tap is worse than one left for
 * the terminal.
 */
export function QuestionCard({
  approval,
  questions,
  context,
  onAnswer,
  onLeave,
}: {
  approval: PendingApproval
  questions: AskedQuestion[]
  /** Which session is asking. Only meaningful where several may be waiting. */
  context?: string
  onAnswer: (approval: PendingApproval, answers: Record<string, string>, response?: string) => void
  onLeave: (approval: PendingApproval) => void
}) {
  // question text → chosen labels. An array even for single-select, so multi-select is
  // the same code path rather than a second one that can drift.
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')

  const toggle = (question: AskedQuestion, label: string) => {
    setPicked((current) => {
      const existing = current[question.question] ?? []
      if (!question.multiSelect) {
        // Tapping the chosen option again clears it — a mis-tap must be undoable.
        return { ...current, [question.question]: existing[0] === label ? [] : [label] }
      }
      const next = existing.includes(label)
        ? existing.filter((value) => value !== label)
        : [...existing, label]
      return { ...current, [question.question]: next }
    })
  }

  const answered = questions.filter((q) => (picked[q.question] ?? []).length > 0).length
  const complete = answered === questions.length
  // Typed words alone are a valid answer: "none of these" is a real reply.
  const canSend = complete || note.trim() !== ''

  const send = () => {
    const answers: Record<string, string> = {}
    for (const question of questions) {
      const chosen = picked[question.question] ?? []
      // Comma-separated for multi-select, matching Claude Code's own answer shape.
      if (chosen.length > 0) answers[question.question] = chosen.join(', ')
    }
    onAnswer(approval, answers, note.trim() === '' ? undefined : note.trim())
  }

  return (
    <motion.article
      layout
      className="question"
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: EXIT }}
      transition={SPRING}
    >
      <div className="head">
        <span className="sigil">
          <MessageCircleQuestion size={17} strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="headtext">
          <h3>Claude is asking</h3>
          <p className="who">{context ?? 'Nothing happens until you answer.'}</p>
        </div>
        {questions.length > 1 ? (
          <span className="progress" aria-hidden="true">
            {answered}/{questions.length}
          </span>
        ) : null}
      </div>

      {questions.map((question) => {
        const chosen = picked[question.question] ?? []
        return (
          <div className="qblock" key={question.question}>
            {question.header ? <span className="qchip">{question.header}</span> : null}
            <p className="qtext">{question.question}</p>
            {question.multiSelect ? <p className="qhint">Choose any that apply</p> : null}
            <div className="qoptions">
              {question.options.map((option) => {
                const on = chosen.includes(option.label)
                return (
                  <Key
                    key={option.label}
                    className={`qoption${on ? ' on' : ''}`}
                    onClick={() => toggle(question, option.label)}
                  >
                    <span className="qtick" aria-hidden="true">
                      {on ? <Check size={13} strokeWidth={3} /> : null}
                    </span>
                    <span className="qbody">
                      <span className="qlabel">{option.label}</span>
                      {option.description ? (
                        <span className="qdesc">{option.description}</span>
                      ) : null}
                      {option.preview && on ? (
                        <span className="qpreview">{option.preview}</span>
                      ) : null}
                    </span>
                  </Key>
                )
              })}
            </div>
          </div>
        )
      })}

      {noteOpen ? (
        <motion.textarea
          className="field note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Say it in your own words…"
          aria-label="Answer in your own words"
          autoFocus
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 76 }}
          transition={SPRING}
        />
      ) : null}

      <div className="qacts">
        <Key className="primary" disabled={!canSend} onClick={send}>
          {complete || note.trim() !== '' ? 'Send answer' : 'Pick an option'}
        </Key>
      </div>

      <div className="approvalfoot">
        {noteOpen ? (
          <span className="small dim">Your words are sent with any options you picked.</span>
        ) : (
          <button type="button" className="tap quiet" onClick={() => setNoteOpen(true)}>
            <PenLine size={14} strokeWidth={2.3} aria-hidden="true" />
            Answer in my own words
          </button>
        )}
        <button type="button" className="tap quiet" onClick={() => onLeave(approval)}>
          Leave for the terminal
        </button>
      </div>
    </motion.article>
  )
}
