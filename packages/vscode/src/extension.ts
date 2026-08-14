import * as vscode from 'vscode'
import { claudeNativeDispatchVerified } from './compatibility.js'
import { createSafeDiagnostics, serializeSafeDiagnostics, type SafeExtensionDiagnostics } from './diagnostics.js'
import { SessionTreeProvider } from './session-tree.js'

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
    sessionTree.refresh()
    void vscode.window.showInformationMessage(
      'LongLeash has not connected this extension to the daemon yet. Safe diagnostics are available now; authenticated session sync is the next Phase 2A gate.',
      'Show diagnostics',
    ).then(async (choice) => {
      if (choice === 'Show diagnostics') {
        await vscode.commands.executeCommand('longleash.phase2a.showDiagnostics')
      }
    })
  })

  context.subscriptions.push(show, copy, refreshSessions, treeView, sessionTree)
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
