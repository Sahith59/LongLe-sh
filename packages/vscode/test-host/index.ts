import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Mocha from 'mocha'
import * as vscode from 'vscode'
import {
  MIN_TESTED_CLAUDE_EXTENSION_VERSION,
  planClaudeOpen,
  planCodexEditor,
} from '../src/contracts.js'
import {
  IDE_PROTOCOL_VERSION,
  type IdeCapability,
  type IdeClientHello,
  type IdeOpenSessionInstruction,
} from '@longleash/protocol'

interface HostCase {
  caseId: string
  expectedRoots: string[]
  expectedTrusted: boolean
  expectedRemote: boolean
  expectedProvider: 'installed' | 'missing'
  coordinationDir?: string
}

const capabilities: IdeCapability[] = [
  'diagnostics.read',
  'sessions.read',
  'transcripts.read',
  'claude.dispatch',
  'codex.render',
]

export async function run(): Promise<void> {
  const encoded = process.env.LONGLEASH_V0_HOST_CASE
  assert.ok(encoded, 'LONGLEASH_V0_HOST_CASE is required')
  const fixture = JSON.parse(encoded) as HostCase

  const mocha = new Mocha({ color: true, timeout: 30_000 })
  mocha.suite.addTest(
    new Mocha.Test('observes the exact disposable extension-host boundary', async () => {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
        path.resolve(folder.uri.fsPath),
      )
      assert.deepEqual(
        roots.sort(),
        fixture.expectedRoots.map((root) => path.resolve(root)).sort(),
      )
      assert.equal(vscode.workspace.isTrusted, fixture.expectedTrusted)
      assert.equal(vscode.env.remoteName !== undefined, fixture.expectedRemote)

      const claude = vscode.extensions.getExtension('anthropic.claude-code')
      assert.equal(claude === undefined ? 'missing' : 'installed', fixture.expectedProvider)

      const longleash = vscode.extensions.getExtension('longleash.longleash')
      assert.ok(longleash, 'LongLeash extension-under-test is installed')
      await longleash.activate()

      const diagnostics = await vscode.commands.executeCommand<string>(
        'longleash.phase2a.getDiagnosticsForTest',
      )
      const sessionTree = await vscode.commands.executeCommand<{
        cursor: number
        sections: unknown[]
      }>('longleash.phase2a.getSessionTreeForTest')
      assert.deepEqual(sessionTree, { cursor: -1, sections: [] })
      const hostSnapshot = {
        v: IDE_PROTOCOL_VERSION,
        type: 'ide.sessionInventory',
        streamId: `daemon_${fixture.caseId}`,
        cursor: 2,
        generatedAt: 2_000,
        sessions: [
          {
            sessionId: `attention_${fixture.caseId}`,
            provider: 'claude',
            title: 'Review exact handoff evidence',
            origin: 'phone',
            status: 'waiting',
            live: true,
            resumable: true,
            attention: 'approval',
            workspace: { label: 'Disposable fixture', mode: 'shared' },
            updatedAt: 1_999,
          },
          {
            sessionId: `history_${fixture.caseId}`,
            provider: 'codex',
            title: 'Earlier verified thread',
            origin: 'vscode',
            status: 'waiting',
            live: false,
            resumable: true,
            workspace: { label: 'Disposable fixture', mode: 'shared' },
            updatedAt: 1_998,
          },
        ],
      }
      assert.equal(
        await vscode.commands.executeCommand<boolean>(
          'longleash.phase2a.setSessionTreeForTest',
          hostSnapshot,
        ),
        true,
      )
      assert.equal(
        await vscode.commands.executeCommand<boolean>(
          'longleash.phase2a.setSessionTreeForTest',
          { ...hostSnapshot, cursor: 1, sessions: [] },
        ),
        false,
        'a stale inventory cursor must not erase a newer tree',
      )
      const populatedTree = await vscode.commands.executeCommand<{
        streamId: string
        cursor: number
        sections: { id: string }[]
      }>('longleash.phase2a.getSessionTreeForTest')
      assert.equal(populatedTree.streamId, `daemon_${fixture.caseId}`)
      assert.equal(populatedTree.cursor, 2)
      assert.deepEqual(populatedTree.sections.map((section) => section.id), ['needs-you', 'earlier'])
      assert.equal(
        await vscode.commands.executeCommand<boolean>(
          'longleash.phase2a.setSessionTreeForTest',
          { ...hostSnapshot, streamId: `daemon_restart_${fixture.caseId}`, cursor: 0, sessions: [] },
        ),
        true,
        'a new daemon stream must replace state even when its cursor restarts at zero',
      )
      const parsed = JSON.parse(diagnostics) as Record<string, unknown>
      assert.equal(parsed.workspaceTrusted, fixture.expectedTrusted)
      assert.equal(parsed.remote, fixture.expectedRemote)
      assert.equal(parsed.workspaceFolderCount, fixture.expectedRoots.length)
      const claudeDiagnostics = parsed.claudeExtension as
        | { installed?: unknown; nativeSessionDispatchVerified?: unknown }
        | undefined
      assert.equal(
        claudeDiagnostics?.installed,
        fixture.expectedProvider === 'installed',
      )
      assert.equal(
        claudeDiagnostics?.nativeSessionDispatchVerified,
        false,
        'an installed provider must not become dispatch-capable without live evidence',
      )

      const serialized = JSON.stringify(parsed)
      for (const root of fixture.expectedRoots) {
        assert.equal(serialized.includes(root), false, 'safe diagnostics must not expose paths')
      }

      const canonicalRoots = roots.map((root) => path.resolve(root))
      const client: IdeClientHello = {
        v: IDE_PROTOCOL_VERSION,
        type: 'ide.hello',
        clientInstanceId: `host_${fixture.caseId}`,
        protocol: { min: IDE_PROTOCOL_VERSION, max: IDE_PROTOCOL_VERSION },
        extension: { version: '0.0.1', build: 'v0-live' },
        vscode: {
          version: vscode.version,
          uriScheme: vscode.env.uriScheme,
          remoteAuthority: vscode.env.remoteName ?? null,
          workspaceTrusted: vscode.workspace.isTrusted,
          windowFocused: true,
          workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
            uri: folder.uri.toString(),
            canonicalPath: path.resolve(folder.uri.fsPath),
          })),
        },
        capabilities,
      }
      const now = Date.now()
      const root = canonicalRoots[0]
      assert.ok(root, 'fixture has at least one canonical root')
      const baseInstruction = {
        v: IDE_PROTOCOL_VERSION,
        type: 'ide.openSession' as const,
        operationId: `op_${fixture.caseId}`,
        issuedAt: now,
        expiresAt: now + 30_000,
        sessionId: `session_${fixture.caseId}`,
        canonicalWorkspace: root,
      } as const
      const claudeInstruction: IdeOpenSessionInstruction = {
        ...baseInstruction,
        provider: 'claude',
        nativeId: '00000000-0000-4000-8000-000000000001',
        destination: 'claude-native',
        nativeRecord: { verifiedAt: now - 1, canonicalWorkspace: root },
        ownership: 'ide-reserved',
      }
      const claudePlan = planClaudeOpen({
        instruction: claudeInstruction,
        client,
        grantedCapabilities: capabilities,
        provider:
          claude === undefined
            ? { installed: false }
            : {
                installed: true,
                version:
                  typeof claude.packageJSON.version === 'string'
                    ? claude.packageJSON.version
                    : MIN_TESTED_CLAUDE_EXTENSION_VERSION,
              },
        now: now + 1,
      })
      if (fixture.expectedProvider === 'installed') {
        assert.deepEqual(claudePlan, {
          kind: 'blocked',
          code: 'provider-contract-unverified',
        })
      } else {
        assert.deepEqual(claudePlan, { kind: 'blocked', code: 'provider-missing' })
      }

      assert.deepEqual(
        planClaudeOpen({
          instruction: {
            ...claudeInstruction,
            nativeRecord: { verifiedAt: now - 6_000, canonicalWorkspace: root },
          },
          client,
          grantedCapabilities: capabilities,
          provider: { installed: true, version: MIN_TESTED_CLAUDE_EXTENSION_VERSION },
          now: now + 1,
        }),
        { kind: 'blocked', code: 'native-session-unverified' },
        'a missing/stale durable record must fail before a provider URI is dispatched',
      )

      const codexInstruction: IdeOpenSessionInstruction = {
        ...baseInstruction,
        provider: 'codex',
        nativeId: 'codex-live-thread',
        destination: 'codex-longleash',
        nativeRecord: { verifiedAt: now - 1, canonicalWorkspace: root },
        ownership: 'read-only',
      }
      assert.deepEqual(
        planCodexEditor({
          instruction: codexInstruction,
          client,
          grantedCapabilities: capabilities,
          snapshot: {
            source: 'daemon-mirror',
            threadId: 'codex-live-thread',
            status: 'idle',
            appServerOwner: 'daemon',
          },
          now: now + 1,
        }),
        {
          kind: 'open-editor',
          verification: 'extension-owned',
          mode: 'read-only',
          threadId: 'codex-live-thread',
        },
      )

      const marker = process.env.LONGLEASH_V0_HOST_MARKER
      assert.ok(marker, 'LONGLEASH_V0_HOST_MARKER is required')
      const markerValue = await readFile(marker, 'utf8').catch(() => '')
      assert.equal(markerValue, '', 'host tests must not mutate the external marker')

      if (fixture.coordinationDir !== undefined) {
        await mkdir(fixture.coordinationDir, { recursive: true })
        await writeFile(path.join(fixture.coordinationDir, `${fixture.caseId}.ready`), '', {
          flag: 'wx',
        })
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          const ready = (await readdir(fixture.coordinationDir)).filter((name) => name.endsWith('.ready'))
          if (ready.length >= 2) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const ready = (await readdir(fixture.coordinationDir)).filter((name) => name.endsWith('.ready'))
        assert.equal(ready.length, 2, 'both disposable VS Code windows reached the barrier')
        await new Promise((resolve) => setTimeout(resolve, 300))
        await writeFile(
          path.join(fixture.coordinationDir, `${fixture.caseId}.result.json`),
          `${JSON.stringify({ caseId: fixture.caseId, focused: vscode.window.state.focused })}\n`,
          { flag: 'wx' },
        )
      }
    }),
  )

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} extension-host assertion(s) failed`))
      else resolve()
    })
  })
}
