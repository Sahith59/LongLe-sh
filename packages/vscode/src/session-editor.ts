import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, type ClientMessage, type SessionEvent } from '@longleash/protocol'
import * as vscode from 'vscode'
import { CompanionClient, type CompanionSession, type OpenRequest, type PendingApproval } from './companion-client.js'

export class SessionEditors implements vscode.Disposable {
  private readonly editors = new Map<string, SessionEditor>()
  constructor(private readonly client: CompanionClient) {}

  async open(sessionId: string, title: string, request?: OpenRequest): Promise<void> {
    let editor = this.editors.get(sessionId)
    if (!editor) {
      editor = new SessionEditor(this.client, sessionId, title, () => this.editors.delete(sessionId))
      this.editors.set(sessionId, editor)
    }
    editor.reveal()
    if (!await editor.load()) throw new Error('The exact conversation could not be loaded.')
    if (request) {
      const version = editor.requestRender()
      await editor.whenRendered(version)
      await this.client.opened(request.requestId, sessionId)
    }
  }

  async actionForTest(sessionId: string, action: Record<string, unknown>): Promise<void> {
    const editor = this.editors.get(sessionId)
    if (!editor) throw new Error('Session editor is not open.')
    await editor.actionForTest(action)
  }

  dispose(): void { for (const editor of this.editors.values()) editor.dispose(); this.editors.clear() }
}

class SessionEditor implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel
  private readonly pending = new Map<string, PendingApproval>()
  private readonly blocks: { kind: string; text: string }[] = []
  private blockCharacters = 0
  private historyTruncated = false
  private session: CompanionSession | undefined
  private cursor = 0
  private currentLoad: Promise<boolean> | undefined
  private online = false
  private busy = false
  private observeOnly = false
  private disposed = false
  private timer: ReturnType<typeof setInterval>
  private renderVersion = 0
  private renderedVersion = 0
  private caughtUp = false
  private renderWaiters: { version: number; resolve: () => void; reject: (error: Error) => void }[] = []

  constructor(private readonly client: CompanionClient, private readonly sessionId: string, title: string, private readonly onDispose: () => void) {
    this.panel = vscode.window.createWebviewPanel('longleash.session', `LongLeash · ${title}`, vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: false,
    })
    this.panel.webview.html = html(this.panel.webview.cspSource)
    this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message) })
    this.panel.onDidDispose(() => this.dispose())
    this.timer = setInterval(() => { void this.load() }, 2_000)
  }

  reveal(): void { this.panel.reveal(vscode.ViewColumn.Beside) }
  async actionForTest(action: Record<string, unknown>): Promise<void> { await this.receive(action) }

  load(): Promise<boolean> {
    if (this.currentLoad) return this.currentLoad
    const operation = this.loadInner()
    this.currentLoad = operation
    void operation.finally(() => { if (this.currentLoad === operation) this.currentLoad = undefined })
    return operation
  }

  private async loadInner(): Promise<boolean> {
    if (this.disposed) return false
    try {
      let pages = 0
      let changed = false
      let hasMore = false
      do {
        const result = await this.client.read(this.sessionId, this.cursor)
        if (result.latestCursor < this.cursor) {
          this.cursor = 0
          this.blocks.length = 0
          this.blockCharacters = 0
          this.historyTruncated = false
          this.pending.clear()
          this.renderVersion = 0
          this.renderedVersion = 0
          changed = true
          continue
        }
        this.session = result.session
        if (result.events.length > 0) {
          for (const event of result.events) this.project(event)
          this.cursor = result.events[result.events.length - 1]!.seq
          changed = true
        }
        if (result.pendingApprovals) {
          const before = JSON.stringify([...this.pending.values()])
          this.pending.clear()
          for (const approval of result.pendingApprovals) this.pending.set(approval.approvalId, approval)
          if (JSON.stringify([...this.pending.values()]) !== before) changed = true
        }
        this.observeOnly = result.session.control === 'observe' || !!result.session.workspaceConflict ||
          (result.session.agent === 'codex' && result.session.controller === 'external' && result.session.control !== 'full')
        hasMore = result.hasMore
        if (!hasMore || result.events.length === 0 || ++pages >= 40) break
      } while (true)
      this.caughtUp = !hasMore
      this.online = true
      if (changed || this.renderVersion === 0) this.update()
      else this.updateStatus()
      return this.caughtUp
    } catch (error) {
      this.online = false
      this.post({ type: 'offline', message: error instanceof Error ? error.message : 'LongLeash is offline.' })
      for (const waiter of this.renderWaiters.splice(0)) waiter.reject(error instanceof Error ? error : new Error('LongLeash is offline.'))
      return false
    }
  }

  requestRender(): number { return this.update() }

  whenRendered(version: number): Promise<void> {
    if (!this.caughtUp) return Promise.reject(new Error('Conversation history is still loading.'))
    if (version > 0 && this.renderedVersion >= version) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.renderWaiters.push({ version, resolve, reject })
      setTimeout(() => {
        const index = this.renderWaiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) { this.renderWaiters.splice(index, 1); reject(new Error('The conversation editor did not confirm rendering.')) }
      }, 5_000)
    })
  }

  private project(event: SessionEvent): void {
    if (event.type === 'session.transcript.reset') {
      this.blocks.length = 0
      this.blockCharacters = 0
      this.historyTruncated = false
      for (const block of event.payload.blocks ?? []) this.appendBlock(block.kind, block.text)
    } else if (event.type === 'stream.delta') {
      this.appendBlock(event.payload.kind, event.payload.text)
    } else if (event.type === 'approval.requested') {
      this.pending.set(event.payload.approvalId, event.payload as PendingApproval)
    } else if (event.type === 'approval.decided') {
      this.pending.delete(event.payload.approvalId)
    } else if (event.type === 'session.started' || event.type === 'session.status') {
      if (event.payload.control === 'observe' || !!event.payload.workspaceConflict) this.observeOnly = true
      else if (event.payload.control === 'full') this.observeOnly = false
    }
  }

  private appendBlock(kind: string, text: string): void {
    if (text.length > 120_000) { text = `…${text.slice(-120_000)}`; this.historyTruncated = true }
    const last = this.blocks.at(-1)
    if (last?.kind === kind && last.text.length + text.length <= 120_000) last.text += text
    else this.blocks.push({ kind, text })
    this.blockCharacters += text.length
    while (this.blocks.length > 1 && (this.blocks.length > 1_500 || this.blockCharacters > 600_000)) {
      this.blockCharacters -= this.blocks.shift()!.text.length
      this.historyTruncated = true
    }
  }

  private update(): number {
    const version = ++this.renderVersion
    this.post({ type: 'state', version, session: this.session, observeOnly: this.observeOnly,
      historyTruncated: this.historyTruncated,
      blocks: this.blocks, approvals: [...this.pending.values()] })
    return version
  }

  private updateStatus(): void { this.post({ type: 'status', session: this.session, observeOnly: this.observeOnly }) }

  private async receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type === 'ready') { if (this.renderVersion > 0) this.update(); return }
    if (message.type === 'rendered' && Number.isSafeInteger(message.version)) {
      this.renderedVersion = Math.max(this.renderedVersion, Number(message.version))
      const ready = this.renderWaiters.filter((waiter) => waiter.version <= this.renderedVersion)
      this.renderWaiters = this.renderWaiters.filter((waiter) => waiter.version > this.renderedVersion)
      for (const waiter of ready) waiter.resolve()
      return
    }
    if (this.disposed || !this.session || !this.online || this.busy) return
    try {
      if (message.type === 'send' && typeof message.text === 'string' && message.text.trim()) {
        if (this.observeOnly) throw new Error('This conversation is view only. Control is unavailable.')
        if (this.session.controller === 'external') throw new Error('Take control of this external session before sending.')
        await this.run({ v: PROTOCOL_VERSION, type: 'sendMessage', sessionId: this.sessionId, text: message.text.trim() })
        this.post({ type: 'sent' })
      } else if (message.type === 'reclaim') {
        if (this.observeOnly) throw new Error('This conversation is view only. Control is unavailable.')
        const choice = await vscode.window.showWarningMessage('Take control of this session? Close its existing Terminal or provider panel first to prevent two writers.', { modal: true }, 'Take control')
        if (choice !== 'Take control') return
        await this.run({ v: PROTOCOL_VERSION, type: 'reclaimSession', sessionId: this.sessionId })
      } else if (message.type === 'resume') {
        if (this.observeOnly) throw new Error('This conversation is view only. Control is unavailable.')
        await this.run({ v: PROTOCOL_VERSION, type: 'resumeSession', sessionId: this.sessionId })
      } else if (message.type === 'stop') {
        if (this.observeOnly) throw new Error('This conversation is view only. Control is unavailable.')
        await this.run({ v: PROTOCOL_VERSION, type: 'stopSession', sessionId: this.sessionId })
      } else if (message.type === 'return') {
        const result = await this.client.returnToPhone(this.sessionId)
        if (result && typeof result === 'object' && (result as { outcome?: unknown }).outcome === 'opened') {
          this.post({ type: 'notice', message: 'The phone confirmed opening this conversation.' })
        } else {
          const detail = result && typeof result === 'object' ? (result as { message?: unknown }).message : undefined
          this.post({ type: 'notice', message: typeof detail === 'string' ? detail : 'The phone has not confirmed opening this conversation.' })
        }
      } else if (message.type === 'decide' && typeof message.approvalId === 'string') {
        await this.decide(message.approvalId, message.verdict)
      }
      await this.load()
    } catch (error) {
      this.post({ type: 'notice', message: error instanceof Error ? error.message : 'The action failed. Check the session before retrying.' })
    }
  }

  private async decide(approvalId: string, verdict: unknown): Promise<void> {
    const approval = this.pending.get(approvalId)
    if (!approval) throw new Error('This request is no longer pending.')
    if (this.observeOnly) throw new Error('This conversation is view only. Control is unavailable.')
    if (approval.questions?.length) {
      if (verdict === 'deny') {
        await this.run({ v: PROTOCOL_VERSION, type: 'decision', approvalId, verdict: 'deny' })
        return
      }
      const answers: Record<string, string> = {}
      for (const question of approval.questions) {
        const choices = question.options.map((option) => ({ label: option.label, description: option.description }))
        const picked = question.multiSelect
          ? await vscode.window.showQuickPick(choices, { title: question.question, canPickMany: true })
          : await vscode.window.showQuickPick(choices, { title: question.question })
        if (!picked || (Array.isArray(picked) && picked.length === 0)) return
        answers[question.question] = Array.isArray(picked) ? picked.map((item) => item.label).join(', ') : picked.label
      }
      await this.run({ v: PROTOCOL_VERSION, type: 'decision', approvalId, verdict: 'allow', answers })
    } else if (verdict === 'allow' || verdict === 'deny') {
      await this.run({ v: PROTOCOL_VERSION, type: 'decision', approvalId, verdict })
    }
  }

  private async run(message: ClientMessage): Promise<void> {
    this.busy = true
    this.post({ type: 'busy', busy: true })
    try { await this.client.command(this.sessionId, randomUUID(), message) }
    finally { this.busy = false; this.post({ type: 'busy', busy: false }) }
  }

  private post(message: unknown): void { if (!this.disposed) void this.panel.webview.postMessage(message) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
    for (const waiter of this.renderWaiters.splice(0)) waiter.reject(new Error('The editor closed.'))
    this.onDispose()
    this.panel.dispose()
  }
}

function html(cspSource: string): string {
  const nonce = randomUUID().replace(/-/g, '')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px}header{position:sticky;top:0;background:var(--vscode-editor-background);padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}#status{font-size:12px;color:var(--vscode-descriptionForeground)}#feed{white-space:pre-wrap;overflow-wrap:anywhere}.block{padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}.kind{font-weight:bold;color:var(--vscode-descriptionForeground)}.approval{border:1px solid var(--vscode-inputValidation-warningBorder);padding:10px;margin:8px 0}button,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:6px}button{cursor:pointer;margin:3px}button:disabled,textarea:disabled{opacity:.5;cursor:not-allowed}textarea{box-sizing:border-box;width:100%;min-height:70px}#notice{color:var(--vscode-errorForeground)}footer{position:sticky;bottom:0;background:var(--vscode-editor-background);padding-top:8px}</style></head>
    <body><header><strong id="title">LongLeash session</strong><div id="status">Loading exact conversation…</div><div><button id="reclaim">Take control</button><button id="resume">Reopen</button><button id="stop">Stop</button><button id="return">Continue on phone</button></div></header><div id="notice" role="status" aria-live="polite"></div><section id="approvals" aria-label="Pending requests"></section><main id="feed" aria-label="Conversation"></main><footer><label for="message">Message</label><textarea id="message" aria-label="Message to agent"></textarea><button id="send">Send</button></footer>
    <script nonce="${nonce}">
      const api=acquireVsCodeApi(),$=id=>document.getElementById(id);
      let session=null,busy=false,online=false,observeOnly=false,approvals=[];
      function emit(type,extra={}){api.postMessage({type,...extra})}
      for(const id of ['reclaim','resume','stop','return'])$(id).addEventListener('click',()=>emit(id));
      $('send').addEventListener('click',()=>{const text=$('message').value;if(text.trim())emit('send',{text})});
      function controls(){
        const external=session?.controller==='external';
        $('reclaim').hidden=!external||observeOnly;
        $('resume').hidden=!session?.resumable||session?.live;
        $('stop').hidden=!session?.live;
        const writable=online&&!busy&&!external&&!observeOnly;
        $('send').disabled=!writable;$('message').disabled=!writable;
        for(const id of ['reclaim','resume','stop','return'])$(id).disabled=!online||busy||(id!=='return'&&observeOnly);
        for(const button of $('approvals').querySelectorAll('button'))button.disabled=!online||busy||observeOnly;
      }
      function showApprovals(){
        const container=$('approvals');container.replaceChildren();
        for(const a of approvals){
          const row=document.createElement('div');row.className='approval';
          const label=document.createElement('div');
          label.textContent=a.questions?.length?a.questions.map(q=>q.question).join(' / '):a.toolName+': '+a.inputSummary;
          row.append(label);
          for(const choice of a.questions?.length?['Answer','Deny']:['Allow','Deny']){
            const button=document.createElement('button');button.textContent=choice;
            button.addEventListener('click',()=>emit('decide',{approvalId:a.approvalId,verdict:choice.toLowerCase()}));row.append(button)
          }
          container.append(row)
        }
      }
      function render(m){
        session=m.session;observeOnly=!!m.observeOnly;online=true;approvals=m.approvals;
        $('notice').textContent=m.historyTruncated?'Older conversation content is omitted in this view. The complete history remains with the laptop service.':'';
        $('title').textContent=session?.title||'LongLeash session';
        $('status').textContent=[session?.agent,session?.status,session?.cwd].filter(Boolean).join(' · ');
        const feed=$('feed');feed.replaceChildren();
        for(const block of m.blocks){
          const row=document.createElement('div');row.className='block';
          const kind=document.createElement('div');kind.className='kind';kind.textContent=block.kind;
          const body=document.createElement('div');body.textContent=block.text;row.append(kind,body);feed.append(row)
        }
        showApprovals();controls();emit('rendered',{version:m.version})
      }
      window.addEventListener('message',event=>{
        const m=event.data;
        if(m.type==='state')render(m);
        else if(m.type==='status'){
          session=m.session;observeOnly=!!m.observeOnly;online=true;
          $('status').textContent=[session?.agent,session?.status,session?.cwd].filter(Boolean).join(' · ');controls()
        }else if(m.type==='offline'){online=false;$('notice').textContent=m.message;controls()}
        else if(m.type==='notice')$('notice').textContent=m.message;
        else if(m.type==='busy'){busy=m.busy;controls()}
        else if(m.type==='sent')$('message').value=''
      });
      controls();emit('ready');
    </script></body></html>`
}
