import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const installer = path.join(packageRoot, 'scripts', 'install-local.mjs')

describe('local VSIX installer', () => {
  it('produces a non-mutating install plan in dry-run mode', () => {
    const output = execFileSync(process.execPath, [installer, '--dry-run', '--code', 'code-insiders'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    const plan = JSON.parse(output) as {
      executable: string
      args: string[]
      artifact: string
      version: string
      executed: boolean
    }

    expect(plan).toMatchObject({
      executable: 'code-insiders',
      artifact: 'longleash-vscode-0.0.1.vsix',
      version: '0.0.1',
      executed: false,
    })
    expect(plan.args[0]).toBe('--install-extension')
    expect(plan.args.at(-1)).toBe('--force')
  })

  it('rejects unknown arguments before invoking VS Code', () => {
    expect(() =>
      execFileSync(process.execPath, [installer, '--unexpected'], {
        cwd: packageRoot,
        stdio: 'pipe',
      }),
    ).toThrow()
  })
})
