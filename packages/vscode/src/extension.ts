import * as vscode from 'vscode'
import { claudeNativeDispatchVerified } from './compatibility.js'
import { createSafeDiagnostics, serializeSafeDiagnostics, type SafeExtensionDiagnostics } from './diagnostics.js'
import { SessionTreeProvider } from './session-tree.js'
import { CompanionClient } from './companion-client.js'
import { SessionEditors } from './session-editor.js'
import { randomUUID } from 'node:crypto'
import { IDE_PROTOCOL_VERSION } from '@longleash/protocol'

const EXTENSION_ID = 'longleash.longleash'
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code'
const CODEX_EXTENSION_ID = 'openai.chatgpt'

export function activate(context: vscode.ExtensionContext): void {
  const sessionTree = new SessionTreeProvider()
  const treeView = vscode.window.createTreeView('longleash.sessions', {
    treeDataProvider: sessionTree,
    showCollapseAll: true,
  })
  treeView.message =
    'LongLeash is offline. Start the laptop daemon to load sessions; no cached sessions are shown.'
  const clientInstanceId = randomUUID()
  const client = new CompanionClient(context, clientInstanceId)
  const editors = new SessionEditors(client)
  let syncing = false
  const sync = async () => {
    if (syncing) return
    syncing = true
    try {
      const inventory = await client.inventory()
      sessionTree.replace(inventory)
      treeView.message = inventory.sessions.length === 0
        ? 'Connected. No LongLeash sessions in this workspace yet.'
        : ''
    } catch (error) {
      sessionTree.replace({
        v: IDE_PROTOCOL_VERSION,
        type: 'ide.sessionInventory',
        streamId: 'offline',
        cursor: 0,
        generatedAt: Date.now(),
        sessions: [],
      })
      treeView.message = error instanceof Error && error.message.includes('trusted local')
        ? error.message
        : 'LongLeash is offline. Start the laptop service, then refresh sessions.'
    } finally { syncing = false }
  }
  // V0's disposable extension-host matrix injects snapshots and must never read the
  // operator's real local credential. Normal installed windows always sync live.
  if (!(context.extensionMode === vscode.ExtensionMode.Test && process.env.LONGLEASH_V0_HOST_CASE && !process.env.LONGLEASH_V1_HOST_LIVE)) {
    void sync()
    const poll = setInterval(() => { void sync() }, 2_000)
    context.subscriptions.push({ dispose: () => clearInterval(poll) })
    const handled = new Set<string>()
    let pollingOpens = false
    const pollOpens = async () => {
      if (pollingOpens) return
      pollingOpens = true
      try {
        const { requests } = await client.poll()
        const queued = new Set(requests.map((request) => request.requestId))
        for (const requestId of handled) if (!queued.has(requestId)) handled.delete(requestId)
        for (const request of requests) {
          if (handled.has(request.requestId)) continue
          handled.add(request.requestId)
          void editors.open(request.sessionId, request.title, request).catch((error) => {
            void vscode.window.showErrorMessage(`LongLeash could not open this conversation: ${error instanceof Error ? error.message : 'unknown error'}`)
          })
        }
      } catch { /* Inventory already presents an offline state; retry on next poll. */ }
      finally { pollingOpens = false }
    }
    void pollOpens()
    const openPoll = setInterval(() => { void pollOpens() }, 2_000)
    context.subscriptions.push({ dispose: () => clearInterval(openPoll) })
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void sync() }))
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void sync() }))
  }

  const show = vscode.commands.registerCommand('longleash.phase2a.showDiagnostics', async () => {
    const diagnostics = collectDiagnostics(context)
    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: serializeSafeDiagnostics(diagnostics),
    })
    await vscode.window.showTextDocument(document, { preview: true })
  })

  const copy = vscode.commands.registerCommand('longleash.phase2a.copyDiagnostics', async () => {
    await vscode.env.clipboard.writeText(serializeSafeDiagnostics(collectDiagnostics(context)))
    await vscode.window.showInformationMessage(
      'LongLeash copied safe diagnostics without paths, prompts, conversation IDs, or credentials.',
    )
  })

  const refreshSessions = vscode.commands.registerCommand('longleash.sessions.refresh', () => {
    void sync()
  })

  const openSession = vscode.commands.registerCommand('longleash.sessions.open', async (sessionId?: string, title?: string) => {
    if (!sessionId) {
      const sessions = sessionTree.sessions()
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage('No LongLeash sessions are available in this workspace. Start the laptop service or open a project with a session.')
        return
      }
      const choice = await vscode.window.showQuickPick(sessions.map((session) => ({
        label: session.title,
        description: `${session.provider === 'claude' ? 'Claude' : 'Codex'} · ${session.workspace.label}`,
        sessionId: session.sessionId,
      })), { title: 'Open LongLeash conversation', placeHolder: 'Choose a session in this workspace' })
      if (!choice) return
      sessionId = choice.sessionId
      title = choice.label
    }
    void editors.open(sessionId, title ?? 'Conversation').catch((error) => {
      void vscode.window.showErrorMessage(`LongLeash could not open this conversation: ${error instanceof Error ? error.message : 'unknown error'}`)
    })
  })

  context.subscriptions.push(show, copy, refreshSessions, openSession, treeView, sessionTree, editors)
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('longleash.phase2a.getDiagnosticsForTest', () =>
        serializeSafeDiagnostics(collectDiagnostics(context)),
      ),
      vscode.commands.registerCommand('longleash.phase2a.getSessionTreeForTest', () =>
        sessionTree.snapshotForTest(),
      ),
      vscode.commands.registerCommand('longleash.phase2a.setSessionTreeForTest', (raw: unknown) =>
        sessionTree.replace(raw),
      ),
      vscode.commands.registerCommand('longleash.phase2a.editorActionForTest', (sessionId: string, action: Record<string, unknown>) =>
        editors.actionForTest(sessionId, action),
      ),
    )
  }
}

export function deactivate(): void {}

function collectDiagnostics(context: vscode.ExtensionContext): SafeExtensionDiagnostics {
  const own = vscode.extensions.getExtension(EXTENSION_ID)
  const claude = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)
  const codex = vscode.extensions.getExtension(CODEX_EXTENSION_ID)
  const version = (extension: vscode.Extension<unknown> | undefined): string | undefined => {
    const candidate = extension?.packageJSON?.version
    return typeof candidate === 'string' ? candidate : undefined
  }
  const claudeVersion = version(claude)
  const codexVersion = version(codex)

  return createSafeDiagnostics({
    schema: 1,
    extensionVersion: version(own) ?? String(context.extension.packageJSON.version ?? '0.0.0'),
    extensionBuild: String(context.extension.packageJSON.version ?? '0.0.0'),
    vscodeVersion: vscode.version,
    uriScheme: vscode.env.uriScheme,
    remote: vscode.env.remoteName !== undefined,
    workspaceTrusted: vscode.workspace.isTrusted,
    windowFocused: vscode.window.state.focused,
    workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    claudeExtension: {
      installed: claude !== undefined,
      ...(claudeVersion === undefined ? {} : { version: claudeVersion }),
      nativeSessionDispatchVerified: claudeNativeDispatchVerified(claudeVersion),
    },
    codexExtension: {
      installed: codex !== undefined,
      ...(codexVersion === undefined ? {} : { version: codexVersion }),
    },
  })
}
