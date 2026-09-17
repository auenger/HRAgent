import type { WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { actOnBrowserFrame, inspectBrowserFrame, type BrowserFrameSnapshot } from './adapters/browser-use.js'
import { beginBrowserVisual, restoreBrowserPointer } from './adapters/browser-visual.js'

type Frame = { id: string; url: string; name?: string; parentId?: string }
type FrameTree = { frame: Frame; childFrames?: FrameTree[] }
type Context = { id: number; session?: string; frame: Frame; key: string; parent?: Context }
type Snapshot = BrowserFrameSnapshot & { path: string; accessibility: Array<{ role: string; name: string }> }
const state = '__agenthrCdpNodes'

/** A private CDP transport for this WebContents only. No debugging port or arbitrary agent scripts. */
export class CdpBrowser {
  private contexts = new Map<string, Context>()
  private signatures = new Map<string, string>()
  private sessions = new Map<string, string>()
  private snapshotId = ''
  private snapshotUrl = ''
  private owned = false
  private busy = false
  private pendingTargets = new Set<Promise<unknown>>()
  private readonly targetMessage = (_event: unknown, method: string, params: any) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
      this.sessions.set(params.targetInfo.targetId, params.sessionId)
      const pending = this.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId)
        .catch(() => {}).finally(() => this.pendingTargets.delete(pending))
      this.pendingTargets.add(pending)
    } else if (method === 'Target.detachedFromTarget') {
      for (const [id, session] of this.sessions) if (session === params.sessionId) this.sessions.delete(id)
    }
  }
  private readonly detached = () => { this.contexts.clear(); this.sessions.clear(); this.snapshotId = ''; this.owned = false }

  constructor(private readonly contents: WebContents, private readonly allowed: (url: string) => boolean) {
    contents.debugger.on('detach', this.detached)
    contents.debugger.on('message', this.targetMessage)
  }

  private async command(method: string, params: Record<string, unknown> = {}, session?: string): Promise<any> {
    if (this.contents.isDestroyed()) throw new Error('浏览器已关闭')
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach('1.3')
      this.owned = true
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.contents.debugger.sendCommand(method, params, session),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CDP ${method} ${params.type || ''} 超时；动作结果可能未知，请先重新读取页面，不要直接重试`)), 10_000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  private async evaluate(context: Context, expression: string, returnByValue = true): Promise<any> {
    const response = await this.command('Runtime.evaluate', { expression, contextId: context.id, returnByValue, awaitPromise: true }, context.session)
    if (response.exceptionDetails) throw new Error(`页面执行失败：${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`)
    return returnByValue ? response.result.value : response.result
  }

  private async call(context: Context, objectId: string, functionDeclaration: string, args: unknown[] = []): Promise<any> {
    const response = await this.command('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true,
    }, context.session)
    if (response.exceptionDetails) throw new Error(`页面执行失败：${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`)
    return response.result.value
  }

  private async owner(context: Context): Promise<string> {
    const parent = context.parent!
    const { backendNodeId } = await this.command('DOM.getFrameOwner', { frameId: context.frame.id }, parent.session)
    const { object } = await this.command('DOM.resolveNode', { backendNodeId, executionContextId: parent.id }, parent.session)
    if (!object.objectId) throw new Error('页面框架入口已变化，请重新读取快照')
    return object.objectId
  }

  private async visible(context: Context): Promise<boolean> {
    if (!context.parent) return true
    const objectId = await this.owner(context)
    try {
      return await this.call(context.parent, objectId, `function() {
        if (!this.isConnected || !this.getClientRects().length) return false;
        for (let el = this; el; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (el.hidden || s.display === 'none' || s.visibility === 'hidden') return false;
        }
        return true;
      }`)
    } finally { await this.command('Runtime.releaseObject', { objectId }, context.parent.session).catch(() => {}) }
  }

  async snapshot(): Promise<{ snapshotId: string; engine: 'cdp'; frames: Snapshot[]; warnings: string[] }> {
    if (this.busy) throw new Error('浏览器操作进行中，请等待完成后读取快照')
    this.busy = true
    try { return await this.readSnapshot() } finally { this.busy = false }
  }

  private async readSnapshot(): Promise<{ snapshotId: string; engine: 'cdp'; frames: Snapshot[]; warnings: string[] }> {
    const url = this.contents.getURL()
    if (!this.allowed(url)) throw new Error('当前页面不在招聘浏览器范围内')
    this.snapshotId = ''
    this.contexts.clear()
    this.signatures.clear()
    await this.command('Page.enable')
    // Auto-attach is scoped to this WebContents and its descendants, never unrelated tabs.
    await this.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    while (this.pendingTargets.size) await Promise.all([...this.pendingTargets])
    const { frameTree } = await this.command('Page.getFrameTree') as { frameTree: FrameTree }
    const trees = new Map<string, FrameTree>()
    const indexTree = (tree: FrameTree) => { trees.set(tree.frame.id, tree); tree.childFrames?.forEach(indexTree) }
    indexTree(frameTree)
    const remoteTrees: FrameTree[] = []
    for (const session of this.sessions.values()) {
      try {
        const remote = (await this.command('Page.getFrameTree', {}, session)).frameTree as FrameTree
        if (!trees.has(remote.frame.id)) { indexTree(remote); remoteTrees.push(remote) }
      } catch { /* A detached target will disappear from the next frame tree. */ }
    }
    for (const remote of remoteTrees) {
      const parent = remote.frame.parentId && trees.get(remote.frame.parentId)
      if (parent) (parent.childFrames ||= []).push(remote)
    }
    const frames: Snapshot[] = []
    const warnings: string[] = []
    const domSnapshots = new Map<string, Promise<any>>()
    let textBudget = 64_000
    let controlBudget = 800
    let count = 0
    const visit = async (tree: FrameTree, parent?: Context): Promise<void> => {
      if (!this.allowed(tree.frame.url)) return
      if (++count > 24) { warnings.push('框架数量超过本次读取上限'); return }
      let session = this.sessions.get(tree.frame.id) || parent?.session
      let world: { executionContextId: number }
      try {
        try {
          world = await this.command('Page.createIsolatedWorld', { frameId: tree.frame.id, worldName: 'agenthr-browser' }, session)
        } catch {
          // An out-of-process iframe has its own CDP target and execution contexts.
          session = this.sessions.get(tree.frame.id)
          if (!session) {
            const attached = await this.command('Target.attachToTarget', { targetId: tree.frame.id, flatten: true })
            session = attached.sessionId as string
            this.sessions.set(tree.frame.id, session)
          }
          world = await this.command('Page.createIsolatedWorld', { frameId: tree.frame.id, worldName: 'agenthr-browser' }, session)
          const remoteTree = await this.command('Page.getFrameTree', {}, session)
          tree = remoteTree.frameTree
        }
        const base = parent ? (tree.frame.name || 'frame').replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 40) || 'frame' : 'main'
        let key = base
        for (let n = 2; this.contexts.has(key); n++) key = `${base}-${n}`
        const context: Context = { id: world.executionContextId, session, frame: tree.frame, parent, key }
        if (!(await this.visible(context))) return
        await this.evaluate(context, `(() => {
          globalThis.${state} ||= { nodes: new Map(), ids: new WeakMap(), next: 0 };
          Object.assign(globalThis.${state}, { extras: new Set(), names: new WeakMap(), blocked: new WeakMap() });
        })()`)
        // Accessibility names complement DOM text, including labels outside input elements.
        let accessibility: Snapshot['accessibility'] = []
        const extraNodes = new Map<number, string>()
        try {
          const ax = await this.command('Accessibility.getFullAXTree', { frameId: tree.frame.id }, session)
          accessibility = ax.nodes.filter((node: any) => !node.ignored && node.name?.value && !['StaticText', 'InlineTextBox'].includes(node.role?.value))
            .slice(0, 200).map((node: any) => ({ role: String(node.role?.value || ''), name: String(node.name.value).slice(0, 160) }))
          for (const node of ax.nodes) {
            const role = String(node.role?.value || '')
            const name = String(node.name?.value || '').slice(0, 160)
            const interactive = /^(button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|treeitem|option|slider|spinbutton)$/u.test(role)
            const namedDismissImage = /^(?:image|img)$/u.test(role) && /^(?:close|关闭|dismiss)$/iu.test(name.trim())
            if (!node.ignored && node.backendDOMNodeId && (interactive || namedDismissImage)) {
              extraNodes.set(node.backendDOMNodeId, name)
            }
          }
        } catch { warnings.push(`${key}：无障碍树不可用，已保留 DOM 控件`) }
        try {
          const cacheKey = session || 'main'
          if (!domSnapshots.has(cacheKey)) domSnapshots.set(cacheKey, this.command('DOMSnapshot.captureSnapshot', { computedStyles: [] }, session))
          const dom = await domSnapshots.get(cacheKey)!
          const doc = dom.documents.find((document: any) => dom.strings[document.frameId] === tree.frame.id)
          for (const index of doc?.nodes.isClickable?.index || []) {
            const backendId = doc.nodes.backendNodeId[index]
            if (!extraNodes.has(backendId)) extraNodes.set(backendId, '')
          }
        } catch { warnings.push(`${key}：点击事件标记不可用，已保留 DOM/无障碍控件`) }
        // Resolve browser-discovered click handlers, even on div/span without cursor or ARIA.
        if (extraNodes.size > 500) warnings.push(`${key}：额外控件超过 500 个，已截断`)
        const extras = [...extraNodes].slice(0, 500)
        for (let offset = 0; offset < extras.length; offset += 25) {
          await Promise.all(extras.slice(offset, offset + 25).map(async ([backendNodeId, name]) => {
            let objectId: string | undefined
            try {
              const { object } = await this.command('DOM.resolveNode', { backendNodeId, executionContextId: context.id }, session)
              objectId = object.objectId
              if (objectId) await this.call(context, objectId, `function(name) {
                if(this.nodeType!==1 || this.ownerDocument!==document) return;
                globalThis.${state}.extras.add(this);
                if(name) globalThis.${state}.names.set(this,name);
              }`, [name])
            } catch { /* A detached node is omitted, never rebound to another element. */ }
            finally { if (objectId) await this.command('Runtime.releaseObject', { objectId }, session).catch(() => {}) }
          }))
        }
        const snapshot = await this.evaluate(context, `(${inspectBrowserFrame.toString()})(document, ${JSON.stringify(key)}, globalThis.${state})`) as BrowserFrameSnapshot
        if (snapshot.controls.length > controlBudget || snapshot.text.length > textBudget) warnings.push(`${key}：快照长度已截断，可滚动后继续读取`)
        snapshot.text = snapshot.text.slice(0, textBudget)
        snapshot.controls = snapshot.controls.slice(0, controlBudget)
        textBudget -= snapshot.text.length
        controlBudget -= snapshot.controls.length
        this.contexts.set(key, context)
        for (const control of snapshot.controls) this.signatures.set(control.ref, control.signature)
        frames.push({ ...snapshot, path: new URL(tree.frame.url).pathname, accessibility })
        for (const child of tree.childFrames || []) await visit(child, context)
      } catch (error) {
        if (!parent) throw error
        warnings.push(`${tree.frame.name || tree.frame.id}：${error instanceof Error ? error.message : '框架读取失败'}`)
      }
    }
    await visit(frameTree)
    if (this.contents.getURL() !== url) throw new Error('读取时页面已导航，请重试')
    this.snapshotUrl = url
    this.snapshotId = randomBytes(12).toString('hex')
    return { snapshotId: this.snapshotId, engine: 'cdp', frames, warnings }
  }

  async act(input: { snapshotId: string; action: string; ref?: string; value?: string; frame?: string }): Promise<{ done: boolean; action: string; verification: string }> {
    if (this.busy) throw new Error('浏览器操作进行中，请等待完成')
    if (!this.snapshotId || input.snapshotId !== this.snapshotId || this.contents.getURL() !== this.snapshotUrl) throw new Error('页面快照已过期，请重新读取')
    const scrolling = input.action === 'scroll_up' || input.action === 'scroll_down'
    const key = scrolling ? input.frame || 'main' : input.ref?.split(':n')[0]
    const context = key ? this.contexts.get(key) : undefined
    const signature = input.ref ? this.signatures.get(input.ref) : undefined
    if (!context || (!scrolling && !signature)) throw new Error('控件或框架引用无效，请重新读取')
    this.busy = true
    let objectId: string | undefined
    try {
      await this.command('Page.bringToFront')
      this.contents.focus()
      // Check every ancestor: a still-alive hidden iframe is not the current page.
      for (let frame: Context | undefined = context; frame; frame = frame.parent) {
        if (!(await this.visible(frame))) throw new Error('目标框架已隐藏，请重新读取当前页面')
      }
      const action = scrolling ? { type: 'scroll', direction: input.action === 'scroll_down' ? 'down' : 'up' } : { type: input.action, ref: input.ref, value: input.value }
      const prepared = await this.evaluate(context, `(() => {
        const restoreBrowserPointer = ${restoreBrowserPointer.toString()};
        const beginBrowserVisual = ${beginBrowserVisual.toString()};
        const inspectBrowserFrame = ${inspectBrowserFrame.toString()};
        return (${actOnBrowserFrame.toString()})(document, ${JSON.stringify(action)}, ${JSON.stringify(signature || '')}, 200, null, globalThis.${state}, ${input.action !== 'select'});
      })()`)
      if (!prepared.done) throw new Error(`${prepared.action}: ${prepared.reason}`)
      if (!scrolling && input.action !== 'select') {
        await this.evaluate(context, `(() => {
          const latest = (${inspectBrowserFrame.toString()})(document, ${JSON.stringify(context.key)}, globalThis.${state});
          const target = latest.controls.find(control => control.ref === ${JSON.stringify(input.ref)});
          if (!target || target.signature !== ${JSON.stringify(signature)}) throw new Error('目标在动作准备期间已变化，请重新读取');
          if (target.blockedReason) throw new Error(target.blockedReason);
        })()`)
        const object = await this.evaluate(context, `globalThis.${state}.nodes.get(${JSON.stringify(input.ref)})`, false)
        objectId = object.objectId
        if (!objectId) throw new Error('目标元素已移除，请重新读取')
        if (input.action === 'click' || input.action === 'hover') {
          let point = await this.call(context, objectId, `function() {
            if (!this.isConnected) throw new Error('目标元素已移除');
            const r = this.getBoundingClientRect();
            const x = (Math.max(0,r.left)+Math.min(innerWidth,r.right))/2;
            const y = (Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;
            const root = this.getRootNode();
            const hit = root.elementFromPoint(x,y);
            if (!hit || !(this === hit || this.contains(hit))) throw new Error('目标被遮挡或不在可视区域');
            for(let node=hit;node;node=node.parentElement) {
              const reason=globalThis.${state}.blocked.get(node);
              if(reason) throw new Error(reason);
              if(node===this) break;
            }
            return {x,y};
          }`)
          // Convert frame-local coordinates to the top-level viewport; also hit-test frame owners.
          for (let child = context; child.parent; child = child.parent) {
            const owner = await this.owner(child)
            try {
              point = await this.call(child.parent, owner, `function(p) {
                const r=this.getBoundingClientRect();
                const sx=r.width/this.offsetWidth, sy=r.height/this.offsetHeight;
                const x=r.left+(this.clientLeft+p.x)*sx, y=r.top+(this.clientTop+p.y)*sy;
                const hit=this.getRootNode().elementFromPoint(x,y);
                if(hit!==this) throw new Error('目标框架被遮挡或超出可视区域');
                return {x,y};
              }`, [point])
            } finally { await this.command('Runtime.releaseObject', { objectId: owner }, child.parent.session).catch(() => {}) }
          }
          if (input.action === 'click') await this.call(context, objectId, `function() {
            const registry=globalThis.${state};
            registry.clickReceived=false;
            const target=this;
            registry.clickListener=event=>{if(event.isTrusted && event.composedPath().includes(target))registry.clickReceived=true;};
            document.addEventListener('click',registry.clickListener,true);
          }`)
          await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
          if (input.action === 'click') {
            await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
            await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
          }
          await this.evaluate(context, 'new Promise(resolve => { const t=setTimeout(resolve,100); requestAnimationFrame(()=>{clearTimeout(t);resolve()}) })')
          if (input.action === 'click' && !await this.evaluate(context, `globalThis.${state}.clickReceived`)) {
            throw new Error('未确认目标收到点击事件，请重新读取页面核对状态，不要直接重复点击')
          }
        } else if (input.action === 'fill') {
          await this.call(context, objectId, `function() {
            this.focus();
            if(document.activeElement!==this && this.getRootNode().activeElement!==this) throw new Error('输入框无法获得焦点');
            if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r);}
            else { this.select(); }
          }`)
          if (input.value) await this.command('Input.insertText', { text: input.value })
          else {
            await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
            await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
          }
        } else if (input.action === 'press_enter') {
          await this.call(context, objectId, 'function() { this.focus(); }')
          await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
          await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        }
      }
      return { done: true, action: input.action, verification: '动作已执行；请读取新快照核对城市、输入值、搜索结果或详情状态，不能据此断言业务操作成功。' }
    } finally {
      await this.evaluate(context, `(() => { const registry=globalThis.${state}; if(registry?.clickListener){document.removeEventListener('click',registry.clickListener,true);delete registry.clickListener;} })()`).catch(() => {})
      if (objectId) await this.command('Runtime.releaseObject', { objectId }, context.session).catch(() => {})
      this.busy = false
    }
  }

  dispose(): void {
    this.contents.debugger.removeListener('detach', this.detached)
    this.contents.debugger.removeListener('message', this.targetMessage)
    if (this.owned && this.contents.debugger.isAttached()) this.contents.debugger.detach()
    this.detached()
  }

  /** Extract from exactly one visible detail frame, irrespective of the search/recommendation route. */
  async readVisibleDocument(pathPrefix: string, extractor: string): Promise<unknown> {
    await this.snapshot()
    const candidates = [...this.contexts.values()].filter(context => new URL(context.frame.url).pathname.startsWith(pathPrefix))
    if (candidates.length !== 1) throw new Error('请先打开恰好一份可见简历详情，再读取简历')
    const context = candidates[0]
    const result = await this.evaluate(context, `(${extractor})(document)`)
    for (let frame: Context | undefined = context; frame; frame = frame.parent) {
      if (!(await this.visible(frame))) throw new Error('简历详情已关闭或变化，请重新读取')
    }
    return result
  }

  /** Extract from the one visible document that currently contains a recognized detail panel. */
  async readSingleVisibleDocument(extractor: string): Promise<unknown> {
    await this.snapshot()
    const matches: Array<{ context: Context; result: unknown }> = []
    for (const context of this.contexts.values()) {
      const result = await this.evaluate(context, `(${extractor})(document)`)
      if (result !== null && result !== undefined) matches.push({ context, result })
    }
    if (matches.length === 0) {
      throw new Error(`当前页面没有识别到可见的简历详情（已检查 ${this.contexts.size} 个页面框架）`)
    }
    if (matches.length !== 1) throw new Error(`当前页面识别到 ${matches.length} 份简历详情，请只保留一份可见详情`)
    for (let frame: Context | undefined = matches[0].context; frame; frame = frame.parent) {
      if (!(await this.visible(frame))) throw new Error('简历详情已关闭或变化，请重新读取')
    }
    return matches[0].result
  }
}
