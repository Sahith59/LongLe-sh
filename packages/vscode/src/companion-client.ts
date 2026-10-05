import { IdeSessionInventorySchema, IDE_PROTOCOL_VERSION, type IdeSessionInventory, type IdeClientHello } from '@longleash/protocol'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'

const TOKEN_KEY = 'longleash.ide.readOnlyToken'

/** This credential can read scoped inventory only. It is distinct from phone and hook secrets. */
export async function fetchCompanionInventory(
  context: vscode.ExtensionContext,
  clientInstanceId: string,
): Promise<IdeSessionInventory> {
  if (!vscode.workspace.isTrusted || vscode.env.remoteName !== undefined || vscode.env.uriScheme !== 'vscode') {
    throw new Error('Open a trusted local VS Code workspace to see LongLeash sessions.')
  }
  const path = join(process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash'), 'ide-endpoint.json')
  const file = lstatSync(path)
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 ||
    (process.getuid && file.uid !== process.getuid()) || file.size > 4_096) {
    throw new Error('The LongLeash companion credential has unsafe file permissions.')
  }
  const endpoint = JSON.parse(readFileSync(path, 'utf8')) as { url?: string; secret?: string }
  if (typeof endpoint.url !== 'string' || typeof endpoint.secret !== 'string' || endpoint.secret.length < 32) {
    throw new Error('The LongLeash companion endpoint is incomplete.')
  }
  const url = new URL(endpoint.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/snapshot' ||
    url.username || url.password || url.search || url.hash) {
    throw new Error('LongLeash companion endpoints must be loopback only.')
  }
  if (await context.secrets.get(TOKEN_KEY) !== endpoint.secret) {
    await context.secrets.store(TOKEN_KEY, endpoint.secret)
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).flatMap((folder) => {
    if (folder.uri.scheme !== 'file') return []
    try {
      return [{ uri: folder.uri.toString(), canonicalPath: realpathSync(folder.uri.fsPath) }]
    } catch { return [] }
  })
  const hello: IdeClientHello = {
    v: IDE_PROTOCOL_VERSION,
    type: 'ide.hello',
    clientInstanceId,
    protocol: { min: IDE_PROTOCOL_VERSION, max: IDE_PROTOCOL_VERSION },
    extension: {
      version: String(context.extension.packageJSON.version),
      build: String(context.extension.packageJSON.version),
    },
    vscode: {
      version: vscode.version,
      uriScheme: vscode.env.uriScheme,
      remoteAuthority: vscode.env.remoteName ?? null,
      workspaceTrusted: vscode.workspace.isTrusted,
      windowFocused: vscode.window.state.focused,
      workspaceFolders: folders,
    },
    capabilities: ['diagnostics.read', 'sessions.read'],
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-longleash-ide': endpoint.secret },
    body: JSON.stringify(hello),
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) throw new Error(`LongLeash companion connection failed (${response.status}).`)
  return IdeSessionInventorySchema.parse(await response.json())
}
