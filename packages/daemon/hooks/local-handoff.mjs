import { openSync } from 'node:fs'
import { ReadStream, WriteStream } from 'node:tty'

/**
 * Give a person at the terminal an immediate path back to the agent's native prompt.
 * Raw mode matters: a line-buffered `/dev/tty` competes poorly with the parent TUI and can
 * swallow the first key. This owns one keystroke, then restores the terminal before returning.
 */
export function laptopHandoff(surface) {
  const never = new Promise(() => {})
  if (
    surface !== 'terminal' ||
    process.env.LONGLEASH_LOCAL_HANDOFF === 'off' ||
    process.platform === 'win32'
  ) return { promise: never, close() {} }

  let input
  let output
  let settled = false
  let resolveHandoff
  const promise = new Promise((resolve) => { resolveHandoff = resolve })
  const close = () => {
    if (settled) return
    settled = true
    try { input?.setRawMode(false) } catch {}
    input?.destroy()
    output?.end()
  }
  try {
    input = new ReadStream(openSync('/dev/tty', 'r'))
    output = new WriteStream(openSync('/dev/tty', 'w'))
    input.setRawMode(true)
    input.resume()
    input.once('data', () => {
      if (!settled) resolveHandoff()
    })
    input.once('error', close)
    output.once('error', close)
    output.write(
      '\nLongLeash mirrored this request to your phone. Press L to decide on this laptop now.\n',
    )
  } catch {
    close()
    return { promise: never, close() {} }
  }
  return { promise, close }
}
