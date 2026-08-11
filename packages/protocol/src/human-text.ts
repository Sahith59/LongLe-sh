/**
 * Text that agent hosts attach to a user turn but the person did not actually say.
 *
 * This lives in protocol rather than only in the daemon because an older event log may
 * already contain the noisy text. The daemon cleans new transcript entries and the app
 * cleans replayed history with the exact same rules.
 */
const MACHINE_TAGS = [
  'ide_opened_file',
  'ide_selection',
  'task-notification',
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'command-args',
  'command-name',
  'recommended_plugins',
  'environment_context',
]

/** A whole block of `<tag>…</tag>`, with nothing else around it. */
const ONLY_TAGS = /^(?:\s*<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*)+$/
const IDE_CONTEXT_HEADER = /^\s*#\s*Context from my IDE setup:/i
const IDE_REQUEST_HEADER = /##\s*My request:\s*/i

/**
 * Return only what the person said in a transcript entry recorded as coming from them.
 * Empty means the entry was entirely host/IDE machinery.
 */
export function humanSaid(text: string): string {
  let remaining = text

  // Codex's IDE host wraps the actual prompt in a Markdown envelope containing open tabs
  // and editor state. Keep the explicit request and discard the wrapper. This exact shape
  // appeared on a real phone as "# Context from my IDE setup …" inside the user's bubble.
  if (IDE_CONTEXT_HEADER.test(remaining)) {
    const request = IDE_REQUEST_HEADER.exec(remaining)
    if (request?.index === undefined) return ''
    remaining = remaining.slice(request.index + request[0].length)
  }

  // Slash commands are the one case where markup wraps something the person genuinely did.
  if (/<command-(name|message|args)>/.test(remaining)) {
    const name = remaining.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim()
    const args = remaining.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
    if (name === undefined || name === '') return ''
    return args ? `${name} ${args}` : name
  }

  // Strip known machine blocks wherever they sit, so a real message that merely arrived
  // alongside one still reaches the phone intact.
  for (const tag of MACHINE_TAGS) {
    remaining = remaining.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '')
    // Unclosed variants appear when a block is truncated mid-write.
    remaining = remaining.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), '')
  }

  // Anything still made entirely of tags is machinery we have not met before.
  if (ONLY_TAGS.test(remaining.trim())) return ''

  return remaining.trim()
}
