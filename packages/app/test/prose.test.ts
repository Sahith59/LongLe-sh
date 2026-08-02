import { describe, expect, it } from 'vitest'
import { parseProse, type ProseBlock } from '../src/ui/prose.js'

const kinds = (blocks: ProseBlock[]) => blocks.map((b) => b.t)

describe('paragraphs', () => {
  it('keeps plain text as one paragraph', () => {
    const blocks = parseProse('Build passes. Want me to commit this?')
    expect(kinds(blocks)).toEqual(['p'])
  })

  it('splits paragraphs on blank lines and keeps soft line-breaks inside one', () => {
    const blocks = parseProse('First point.\nStill the first.\n\nSecond point.')
    expect(kinds(blocks)).toEqual(['p', 'p'])
    expect(blocks[0]).toMatchObject({ inline: [{ t: 'text', text: 'First point.\nStill the first.' }] })
  })

  it('renders inline code and bold instead of leaking the markup', () => {
    const [p] = parseProse('State lives in a `useState` array — **no** persistence layer.')
    expect(p).toMatchObject({
      t: 'p',
      inline: [
        { t: 'text', text: 'State lives in a ' },
        { t: 'code', text: 'useState' },
        { t: 'text', text: ' array — ' },
        { t: 'strong', inline: [{ t: 'text', text: 'no' }] },
        { t: 'text', text: ' persistence layer.' },
      ],
    })
  })
})

describe('lists — how agents actually answer', () => {
  it('groups consecutive dashes into one bulleted list', () => {
    const blocks = parseProse('Recap:\n- Node/Express app: `server.js`\n- Data lives in `notes.json`')
    expect(kinds(blocks)).toEqual(['p', 'bullets'])
    const bullets = blocks[1] as Extract<ProseBlock, { t: 'bullets' }>
    expect(bullets.items).toHaveLength(2)
    expect(bullets.items[0]?.[1]).toMatchObject({ t: 'code', text: 'server.js' })
  })

  it('accepts * and • markers and slight indentation', () => {
    const blocks = parseProse('* one\n  • two\n   - three')
    expect(kinds(blocks)).toEqual(['bullets'])
    expect((blocks[0] as Extract<ProseBlock, { t: 'bullets' }>).items).toHaveLength(3)
  })

  it('keeps numbered steps numbered, starting where the agent started', () => {
    const blocks = parseProse('3. Open the app\n4. Add a note')
    const list = blocks[0] as Extract<ProseBlock, { t: 'numbered' }>
    expect(list.t).toBe('numbered')
    expect(list.start).toBe(3)
    expect(list.items).toHaveLength(2)
  })

  it('a hyphen mid-sentence is not a bullet', () => {
    const blocks = parseProse('Rewrote the parser - the old one leaked.')
    expect(kinds(blocks)).toEqual(['p'])
  })
})

describe('fenced code — where the old renderer fell apart', () => {
  it('turns a fence into a code block, preserving the content verbatim', () => {
    const blocks = parseProse('Run this:\n```bash\ncd ~/app\nnpm install && npm start\n```\nDone.')
    expect(kinds(blocks)).toEqual(['p', 'fence', 'p'])
    const fence = blocks[1] as Extract<ProseBlock, { t: 'fence' }>
    expect(fence.lang).toBe('bash')
    expect(fence.code).toBe('cd ~/app\nnpm install && npm start')
  })

  it('never mangles markdown inside a fence', () => {
    const [fence] = parseProse('```\n- not a bullet\n**not bold** and `not inline`\n```')
    expect(fence).toMatchObject({ t: 'fence', code: '- not a bullet\n**not bold** and `not inline`' })
  })

  it('treats an unterminated fence as code to the end — mid-stream a fence has no close yet', () => {
    const blocks = parseProse('Writing the fix:\n```ts\nconst x =')
    expect(kinds(blocks)).toEqual(['p', 'fence'])
    expect((blocks[1] as Extract<ProseBlock, { t: 'fence' }>).code).toBe('const x =')
  })

  it('a fence marker mid-sentence stays prose', () => {
    const blocks = parseProse('Use ``` to fence code.')
    expect(kinds(blocks)).toEqual(['p'])
  })
})

describe('headings', () => {
  it('renders ### as a heading line, not literal hashes', () => {
    const blocks = parseProse('### Next steps\nWant me to add auth?')
    expect(kinds(blocks)).toEqual(['heading', 'p'])
    expect(blocks[0]).toMatchObject({ inline: [{ t: 'text', text: 'Next steps' }] })
  })
})

describe('resilience', () => {
  it('returns nothing for whitespace-only input', () => {
    expect(parseProse('   \n  \n')).toEqual([])
  })

  it('survives the real transcript that looked broken on the phone', () => {
    const real = [
      "Same answer as a moment ago — it's at `/Users/sahith/Sticknotes-app`.",
      '',
      'Recap:',
      '- Node/Express app: `server.js`, `public/`, `package.json`, Vercel-deployed (`vercel.json`, `.vercel/`)',
      '- Data lives in `notes.json`',
      '',
      'To run it:',
      '```bash',
      'cd ~/Sticknotes-app && npm start',
      '```',
      '1. Open http://localhost:3000',
      '2. Add a note',
    ].join('\n')
    expect(kinds(parseProse(real))).toEqual(['p', 'p', 'bullets', 'p', 'fence', 'numbered'])
  })
})

describe('bold wrapping code — the exact leak from the phone screenshot', () => {
  it('parses **`path`** as bold containing a code chip, never literal backticks', () => {
    const [p] = parseProse('Found it: **`/Users/sahith/Sticknotes-app`**')
    expect(p).toMatchObject({
      t: 'p',
      inline: [
        { t: 'text', text: 'Found it: ' },
        { t: 'strong', inline: [{ t: 'code', text: '/Users/sahith/Sticknotes-app' }] },
      ],
    })
  })

  it('mixed bold: text and code together', () => {
    const [p] = parseProse('**run `npm start` now**')
    expect(p).toMatchObject({
      inline: [
        {
          t: 'strong',
          inline: [
            { t: 'text', text: 'run ' },
            { t: 'code', text: 'npm start' },
            { t: 'text', text: ' now' },
          ],
        },
      ],
    })
  })
})
