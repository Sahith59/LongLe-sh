import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import readline from 'node:readline'

const threadId = process.env.LONGLEASH_CODEX_THREAD_ID
if (!threadId || !/^[a-zA-Z0-9_-]{8,120}$/u.test(threadId)) {
  throw new Error('LONGLEASH_CODEX_THREAD_ID must name one disposable thread')
}

const appServer = spawn('codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})
const lines = readline.createInterface({ input: appServer.stdout })
const responses = new Map()
let stderr = ''
appServer.stderr.setEncoding('utf8').on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4_000)
})

function send(message) {
  appServer.stdin.write(`${JSON.stringify(message)}\n`)
}

function response(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      responses.delete(id)
      reject(new Error(`app-server request ${id} timed out`))
    }, 20_000)
    responses.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(`app-server request ${id} failed: ${message.error.message}`))
      else resolve(message.result)
    })
  })
}

lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message.id === 'number') responses.get(message.id)?.(message)
})

try {
  const initialized = response(0)
  send({
    method: 'initialize',
    id: 0,
    params: {
      clientInfo: {
        name: 'longleash_v0_probe',
        title: 'LongLeash V0 Read-Only Probe',
        version: '0.0.1',
      },
    },
  })
  await initialized
  send({ method: 'initialized', params: {} })

  const beforeLoaded = response(1)
  send({ method: 'thread/loaded/list', id: 1, params: {} })
  const before = await beforeLoaded

  const threadRead = response(2)
  send({
    method: 'thread/read',
    id: 2,
    params: { threadId, includeTurns: true },
  })
  const read = await threadRead

  const afterLoaded = response(3)
  send({ method: 'thread/loaded/list', id: 3, params: {} })
  const after = await afterLoaded

  if (read?.thread?.id !== threadId) throw new Error('thread/read returned a different thread')
  if (!Array.isArray(read.thread.turns) || read.thread.turns.length < 1) {
    throw new Error('thread/read did not return the disposable turn')
  }
  if (!JSON.stringify(read.thread.turns).includes('LONGLEASH_PHASE2A_CODEX_OK')) {
    throw new Error('thread/read did not return the expected disposable transcript')
  }
  if (before?.data?.includes(threadId) || after?.data?.includes(threadId)) {
    throw new Error('thread/read unexpectedly loaded or resumed the thread')
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 1,
        threadFingerprint: createHash('sha256').update(threadId).digest('hex').slice(0, 12),
        exactThread: true,
        transcriptObserved: true,
        status: read.thread.status?.type ?? 'unknown',
        loadedBefore: false,
        loadedAfter: false,
        mutationMethodsSent: 0,
      },
      null,
      2,
    )}\n`,
  )
} catch (error) {
  const detail = stderr.trim() === '' ? '' : `; app-server stderr: ${stderr.trim()}`
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
} finally {
  lines.close()
  appServer.stdin.end()
  appServer.kill('SIGTERM')
}
