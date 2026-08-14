import { IdeSessionInventorySchema, type IdeSessionSummary } from '@longleash/protocol'
import { createHash } from 'node:crypto'
import * as vscode from 'vscode'
import {
  buildInventorySections,
  sessionStateLabel,
  type InventorySection,
} from './inventory.js'

type SessionTreeNode =
  | { kind: 'section'; section: InventorySection }
  | { kind: 'session'; session: IdeSessionSummary }

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeNode> {
  private readonly changed = new vscode.EventEmitter<SessionTreeNode | undefined | void>()
  readonly onDidChangeTreeData = this.changed.event
  private sections: InventorySection[] = []
  private cursor = -1
  private streamId: string | undefined

  replace(raw: unknown): boolean {
    const inventory = IdeSessionInventorySchema.parse(raw)
    if (inventory.streamId === this.streamId && inventory.cursor <= this.cursor) return false
    this.sections = buildInventorySections(inventory)
    this.cursor = inventory.cursor
    this.streamId = inventory.streamId
    this.changed.fire()
    return true
  }

  refresh(): void {
    this.changed.fire()
  }

  getTreeItem(node: SessionTreeNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(
        node.section.label,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.description = String(node.section.sessions.length)
      item.contextValue = `longleash.section.${node.section.id}`
      item.accessibilityInformation = {
        label: `${node.section.label}, ${node.section.sessions.length} sessions`,
        role: 'treeitem',
      }
      return item
    }

    const { session } = node
    const state = sessionStateLabel(session)
    const provider = session.provider === 'claude' ? 'Claude' : 'Codex'
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None)
    item.id = `longleash.session.${createHash('sha256').update(session.sessionId).digest('hex')}`
    item.description = `${provider} · ${state}`
    item.contextValue = `longleash.session.${session.provider}.${session.live ? 'live' : 'dormant'}`
    item.iconPath = iconFor(session)
    item.tooltip = tooltipFor(session, provider, state)
    item.accessibilityInformation = {
      label: `${session.title}, ${provider}, ${state}, ${session.workspace.label}`,
      role: 'treeitem',
    }
    return item
  }

  getChildren(node?: SessionTreeNode): SessionTreeNode[] {
    if (node === undefined) {
      return this.sections.map((section) => ({ kind: 'section', section }))
    }
    return node.kind === 'section'
      ? node.section.sessions.map((session) => ({ kind: 'session', session }))
      : []
  }

  snapshotForTest(): { streamId?: string; cursor: number; sections: InventorySection[] } {
    return {
      ...(this.streamId === undefined ? {} : { streamId: this.streamId }),
      cursor: this.cursor,
      sections: this.sections,
    }
  }

  dispose(): void {
    this.changed.dispose()
  }
}

function iconFor(session: IdeSessionSummary): vscode.ThemeIcon {
  if (session.attention === 'error') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
  }
  if (session.attention !== undefined) {
    return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'))
  }
  if (session.live) {
    return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
  }
  return new vscode.ThemeIcon('history')
}

function tooltipFor(
  session: IdeSessionSummary,
  provider: string,
  state: string,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true)
  tooltip.isTrusted = false
  tooltip.supportHtml = false
  tooltip.appendMarkdown(`**${escapeMarkdown(session.title)}**\n\n`)
  tooltip.appendMarkdown(`${provider} · ${state}\n\n`)
  tooltip.appendMarkdown(`Workspace: ${escapeMarkdown(session.workspace.label)}`)
  if (session.workspace.branch !== undefined) {
    tooltip.appendMarkdown(` · Branch: ${escapeMarkdown(session.workspace.branch)}`)
  }
  tooltip.appendMarkdown(`\n\nOrigin: ${escapeMarkdown(session.origin)}`)
  return tooltip
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/gu, '\\$&')
}
