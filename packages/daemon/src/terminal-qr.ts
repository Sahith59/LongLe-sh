import qrcode from 'qrcode-terminal'

/** A decoded QR module: true is black, false is white. */
type Module = boolean

/**
 * qrcode-terminal's compact renderer intentionally relies on the terminal's default foreground
 * and background colours. That makes the exact same glyph grid scan in a dark terminal and turn
 * into a photographic negative in a light terminal. Decode its compact output back to modules so
 * we can paint both halves of every cell explicitly.
 */
export function qrModules(input: string): Module[][] {
  let compact = ''
  qrcode.generate(input, { small: true }, (value) => {
    compact = value
  })

  const lines = compact.replace(/\n$/, '').split('\n')
  if (lines.length < 2) throw new Error('QR renderer returned no module rows')

  // The compact format has one glyph of side padding and a special top border. A QR is always
  // square, so the inner width is also the number of real rows (the renderer may append one
  // white row solely to pair the final odd row).
  const moduleCount = [...(lines[1] ?? '')].length - 2
  if (moduleCount < 21) throw new Error('QR renderer returned an invalid module grid')

  const modules: Module[][] = []
  for (const line of lines.slice(1)) {
    const cells = [...line].slice(1, moduleCount + 1)
    if (cells.length !== moduleCount) throw new Error('QR renderer returned a ragged module grid')
    const top: Module[] = []
    const bottom: Module[] = []
    for (const cell of cells) {
      switch (cell) {
        case '█':
          top.push(false)
          bottom.push(false)
          break
        case '▀':
          top.push(false)
          bottom.push(true)
          break
        case '▄':
          top.push(true)
          bottom.push(false)
          break
        case ' ':
          top.push(true)
          bottom.push(true)
          break
        default:
          throw new Error(`QR renderer returned an unknown cell ${JSON.stringify(cell)}`)
      }
    }
    modules.push(top, bottom)
  }
  return modules.slice(0, moduleCount)
}

const QUIET_ZONE = 4
const RESET = '\u001b[0m'
const BLACK = '0;0;0'
const WHITE = '255;255;255'

/**
 * Render a theme-independent compact terminal QR.
 *
 * `▀` lets one character carry two square QR modules. Foreground paints the top half and
 * background paints the bottom half. Use true-colour black and white instead of the ANSI palette:
 * terminals are allowed to remap palette "white" to grey (and commonly do), which lowers QR
 * contrast even when the shell theme is otherwise correct. Four pure-white modules surround the
 * code as the standard quiet zone scanners expect.
 */
export function terminalQr(input: string): string {
  const source = qrModules(input)
  const whiteRow = Array<Module>(source.length + QUIET_ZONE * 2).fill(false)
  const padded = [
    ...Array.from({ length: QUIET_ZONE }, () => [...whiteRow]),
    ...source.map((row) => [
      ...Array<Module>(QUIET_ZONE).fill(false),
      ...row,
      ...Array<Module>(QUIET_ZONE).fill(false),
    ]),
    ...Array.from({ length: QUIET_ZONE }, () => [...whiteRow]),
  ]

  // QR widths are odd. Pairing rows therefore needs one additional white row; adding it below
  // only increases the bottom quiet zone and leaves the symbol itself untouched.
  if (padded.length % 2 !== 0) padded.push([...whiteRow])

  const output: string[] = []
  for (let row = 0; row < padded.length; row += 2) {
    const top = padded[row]
    const bottom = padded[row + 1]
    if (!top || !bottom) throw new Error('QR row pairing failed')
    let line = ''
    let lastStyle = ''
    for (let col = 0; col < top.length; col += 1) {
      const foreground = top[col] ? BLACK : WHITE
      const background = bottom[col] ? BLACK : WHITE
      const style = `\u001b[38;2;${foreground};48;2;${background}m`
      if (style !== lastStyle) {
        line += style
        lastStyle = style
      }
      line += '▀'
    }
    output.push(`${line}${RESET}`)
  }
  return output.join('\n')
}
