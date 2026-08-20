import qrcode from 'qrcode-terminal'

type Module = boolean

/** Keep service-requested pairing QRs readable in both light and dark terminal themes. */
export function terminalQr(input: string): string {
  const source = qrModules(input)
  const quiet = 4
  const whiteRow = Array<Module>(source.length + quiet * 2).fill(false)
  const padded = [
    ...Array.from({ length: quiet }, () => [...whiteRow]),
    ...source.map((row) => [
      ...Array<Module>(quiet).fill(false),
      ...row,
      ...Array<Module>(quiet).fill(false),
    ]),
    ...Array.from({ length: quiet }, () => [...whiteRow]),
  ]
  if (padded.length % 2 !== 0) padded.push([...whiteRow])

  const output: string[] = []
  for (let row = 0; row < padded.length; row += 2) {
    const top = padded[row]
    const bottom = padded[row + 1]
    if (!top || !bottom) throw new Error('QR row pairing failed')
    let line = ''
    let lastStyle = ''
    for (let col = 0; col < top.length; col += 1) {
      const rendered = cell(top[col] ?? false, bottom[col] ?? false)
      if (rendered.style !== lastStyle) {
        line += rendered.style
        lastStyle = rendered.style
      }
      line += rendered.glyph
    }
    output.push(`${line}\u001b[0m`)
  }
  return output.join('\n')
}

function qrModules(input: string): Module[][] {
  let compact = ''
  qrcode.generate(input, { small: true }, (value) => { compact = value })
  const lines = compact.replace(/\n$/, '').split('\n')
  if (lines.length < 2) throw new Error('QR renderer returned no module rows')
  const moduleCount = [...(lines[1] ?? '')].length - 2
  if (moduleCount < 21) throw new Error('QR renderer returned an invalid module grid')

  const modules: Module[][] = []
  for (const line of lines.slice(1)) {
    const cells = [...line].slice(1, moduleCount + 1)
    if (cells.length !== moduleCount) throw new Error('QR renderer returned a ragged module grid')
    const top: Module[] = []
    const bottom: Module[] = []
    for (const value of cells) {
      if (value === '█') { top.push(false); bottom.push(false) }
      else if (value === '▀') { top.push(false); bottom.push(true) }
      else if (value === '▄') { top.push(true); bottom.push(false) }
      else if (value === ' ') { top.push(true); bottom.push(true) }
      else throw new Error(`QR renderer returned an unknown cell ${JSON.stringify(value)}`)
    }
    modules.push(top, bottom)
  }
  return modules.slice(0, moduleCount)
}

function cell(top: Module, bottom: Module): { style: string; glyph: string } {
  const black = '0;0;0'
  const white = '255;255;255'
  if (top === bottom) {
    const colour = top ? black : white
    return { style: `\u001b[38;2;${colour};48;2;${colour}m`, glyph: '█' }
  }
  return {
    // Black remains the continuous cell background, avoiding font seams through finder patterns.
    style: `\u001b[38;2;${white};48;2;${black}m`,
    glyph: top ? '▄' : '▀',
  }
}
