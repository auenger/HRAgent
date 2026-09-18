import type { WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import {
  actOnBrowserFrame,
  inspectBrowserFrame,
  type BrowserControl,
  type BrowserFrameSnapshot,
} from './adapters/browser-use.js'
import { beginBrowserVisual, markBrowserVisualDispatched, restoreBrowserPointer, type PointerPoint } from './adapters/browser-visual.js'

type Frame = { id: string; url: string; name?: string; parentId?: string }
type FrameTree = { frame: Frame; childFrames?: FrameTree[] }
type Context = { id: number; session?: string; frame: Frame; key: string; parent?: Context }
export interface BrowserAccessibilityNode {
  id: string
  parentId: string | null
  role: string
  name: string
  value?: string
  description?: string
  states: Record<string, string | number | boolean>
}
export interface BrowserAccessibilitySnapshot {
  mode: 'full' | 'diff'
  revision: number
  rootIds?: string[]
  nodes?: BrowserAccessibilityNode[]
  added?: BrowserAccessibilityNode[]
  changed?: BrowserAccessibilityNode[]
  removed?: string[]
}
export type BrowserWaitCondition =
  | { type: 'control_value'; ref: string; value: string; timeoutMs?: number }
  | { type: 'control_state'; ref: string; state: 'checked' | 'expanded'; value: string | boolean; timeoutMs?: number }
  | { type: 'control_present'; ref: string; timeoutMs?: number }
  | { type: 'control_absent'; ref: string; timeoutMs?: number }
  | { type: 'text_contains'; frame?: string; value: string; timeoutMs?: number }
  | { type: 'text_absent'; frame?: string; value: string; timeoutMs?: number }
  | { type: 'url_path'; value: string; timeoutMs?: number }
  | { type: 'url_changed'; timeoutMs?: number }
export interface BrowserActionReceipt {
  receiptId: string
  action: string
  target: { ref?: string; frame: string; label?: string; kind?: string }
  before: { urlPath: string; control?: Partial<BrowserControl> }
  dispatch: { confirmed: boolean; at: string; mechanism: 'cdp_input' | 'dom_api'; trustedInput: boolean }
  presentation: { cursorShown: boolean; purpose: 'visualization_only'; target?: PointerPoint }
  wait: { requested: boolean; condition?: BrowserWaitCondition; satisfied: boolean; elapsedMs: number; evidence: string }
  after: { urlPath: string; control?: Partial<BrowserControl> }
  durationMs: number
}
type Snapshot = BrowserFrameSnapshot & { path: string; accessibility: BrowserAccessibilitySnapshot }
const state = '__agenthrCdpNodes'

export function buildAccessibilitySnapshot(key: string, rawNodes: any[], revision: number, previous?: Map<string, BrowserAccessibilityNode>): { snapshot: BrowserAccessibilitySnapshot; current: Map<string, BrowserAccessibilityNode> } {
  const compact = (value: unknown, limit = 300) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
  const allowedStates = new Set(['busy', 'checked', 'disabled', 'expanded', 'focused', 'level', 'multiselectable', 'orientation', 'pressed', 'readonly', 'required', 'selected'])
  const nodes = rawNodes.filter(node => !node.ignored).slice(0, 600).map(node => {
    const states: Record<string, string | number | boolean> = {}
    for (const property of node.properties ?? []) {
      if (!allowedStates.has(String(property.name))) continue
      const value = property.value?.value
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') states[String(property.name)] = value
    }
    const id = `${key}:ax:${String(node.nodeId)}`
    return { id, parentId: node.parentId ? `${key}:ax:${String(node.parentId)}` : null,
      role: compact(node.role?.value, 80), name: compact(node.name?.value),
      ...(node.value?.value === undefined ? {} : { value: compact(node.value.value, 500) }),
      ...(node.description?.value === undefined ? {} : { description: compact(node.description.value, 500) }), states } satisfies BrowserAccessibilityNode
  })
  const current = new Map(nodes.map(node => [node.id, node]))
  const rootIds = nodes.filter(node => !node.parentId || !current.has(node.parentId)).map(node => node.id)
  if (!previous) return { snapshot: { mode: 'full', revision, rootIds, nodes }, current }
  const added: BrowserAccessibilityNode[] = [], changed: BrowserAccessibilityNode[] = []
  for (const node of nodes) {
    const before = previous.get(node.id)
    if (!before) added.push(node)
    else if (JSON.stringify(before) !== JSON.stringify(node)) changed.push(node)
  }
  const removed = [...previous.keys()].filter(id => !current.has(id))
  return { snapshot: { mode: 'diff', revision, rootIds, added, changed, removed }, current }
}

/** A private CDP transport for this WebContents only. No debugging port or arbitrary agent scripts. */
export class CdpBrowser {
  private contexts = new Map<string, Context>()
  private signatures = new Map<string, string>()
  private controls = new Map<string, BrowserControl>()
  private sessions = new Map<string, string>()
  private accessibility = new Map<string, Map<string, BrowserAccessibilityNode>>()
  private accessibilityRevision = 0
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
  private readonly detached = () => { this.contexts.clear(); this.controls.clear(); this.sessions.clear(); this.accessibility.clear(); this.snapshotId = ''; this.owned = false }

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

  private accessibilitySnapshot(key: string, rawNodes: any[], revision: number, previous: Map<string, BrowserAccessibilityNode> | undefined): { snapshot: BrowserAccessibilitySnapshot; current: Map<string, BrowserAccessibilityNode> } {
    return buildAccessibilitySnapshot(key, rawNodes, revision, previous)
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
    this.controls.clear()
    const previousAccessibility = this.snapshotUrl === url ? this.accessibility : new Map<string, Map<string, BrowserAccessibilityNode>>()
    const nextAccessibility = new Map<string, Map<string, BrowserAccessibilityNode>>()
    const accessibilityRevision = this.accessibilityRevision + 1
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
    let accessibilityBudget = 1_200
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
        // Preserve the semantic AX hierarchy and emit a bounded diff after the first snapshot.
        let accessibility: Snapshot['accessibility'] = { mode: 'full', revision: accessibilityRevision, rootIds: [], nodes: [] }
        const extraNodes = new Map<number, string>()
        try {
          const ax = await this.command('Accessibility.getFullAXTree', { frameId: tree.frame.id }, session)
          const semanticNodes = ax.nodes.filter((node: any) => !node.ignored).slice(0, Math.max(0, accessibilityBudget))
          if (ax.nodes.filter((node: any) => !node.ignored).length > semanticNodes.length) warnings.push(`${key}：无障碍树超过本次 1200 节点总预算，已截断`)
          accessibilityBudget -= semanticNodes.length
          const built = this.accessibilitySnapshot(key, semanticNodes, accessibilityRevision, previousAccessibility.get(key))
          accessibility = built.snapshot
          nextAccessibility.set(key, built.current)
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
        for (const control of snapshot.controls) { this.signatures.set(control.ref, control.signature); this.controls.set(control.ref, control) }
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
    this.accessibility = nextAccessibility
    this.accessibilityRevision = accessibilityRevision
    this.snapshotId = randomBytes(12).toString('hex')
    return { snapshotId: this.snapshotId, engine: 'cdp', frames, warnings }
  }

  private async dispatchTrustedPointer(
    context: Context,
    objectId: string,
    action: 'click' | 'hover',
    options: { enforceBlockedReason: boolean; previousPointer?: PointerPoint | null; visualDurationMs?: number } = { enforceBlockedReason: true },
  ): Promise<{ point: PointerPoint; visualPoint?: PointerPoint }> {
    let visualPoint: PointerPoint | undefined
    if (options.visualDurationMs !== undefined) {
      const visual = await this.call(context, objectId, `async function(previous, duration) {
        const restoreBrowserPointer = ${restoreBrowserPointer.toString()};
        const beginBrowserVisual = ${beginBrowserVisual.toString()};
        const result = await beginBrowserVisual(document, this, previous, duration);
        return { point: result.point };
      }`, [options.previousPointer ?? null, options.visualDurationMs]) as { point: PointerPoint }
      visualPoint = visual.point
    }
    let point = await this.call(context, objectId, `function(enforceBlockedReason) {
      if (!this.isConnected) throw new Error('目标元素已移除');
      const r=this.getBoundingClientRect();
      const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2;
      const y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;
      const hit=this.getRootNode().elementFromPoint(x,y);
      if (!hit || !(this===hit || this.contains(hit))) throw new Error('目标被遮挡或不在可视区域');
      if (enforceBlockedReason) for(let node=hit;node;node=node.parentElement) {
        const reason=globalThis.${state}.blocked.get(node);
        if(reason) throw new Error(reason);
        if(node===this) break;
      }
      return {x,y};
    }`, [options.enforceBlockedReason]) as PointerPoint
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
    if (action === 'click') await this.call(context, objectId, `function() {
      const registry=globalThis.${state};
      registry.clickReceived=false;
      const target=this;
      registry.clickListener=event=>{if(event.isTrusted && event.composedPath().includes(target))registry.clickReceived=true;};
      document.addEventListener('click',registry.clickListener,true);
    }`)
    await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    if (action === 'click') {
      await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    }
    await this.evaluate(context, `(${markBrowserVisualDispatched.toString()})(document)`).catch(() => {})
    await this.evaluate(context, 'new Promise(resolve => { const t=setTimeout(resolve,100); requestAnimationFrame(()=>{clearTimeout(t);resolve()}) })')
    if (action === 'click' && !await this.evaluate(context, `globalThis.${state}.clickReceived`)) {
      throw new Error('未确认目标收到可信点击事件，请重新读取页面核对状态，不要直接重复点击')
    }
    return { point, ...(visualPoint ? { visualPoint } : {}) }
  }

  /**
   * Runs a trusted, application-owned target resolver and dispatches one real CDP click.
   * Resolver code is bundled with AgentHR and is never accepted from an Agent/tool argument.
   */
  async clickResolvedTarget<T>(input: {
    action: string
    label: string
    resolver: (doc: Document, value: T) => HTMLElement | null
    value: T
    previousPointer?: PointerPoint | null
    visualDurationMs?: number
  }): Promise<{ pointer: PointerPoint; receipt: BrowserActionReceipt }> {
    await this.snapshot()
    if (this.busy) throw new Error('浏览器操作进行中，请等待完成')
    const matches: Array<{ context: Context; objectId: string }> = []
    for (const context of this.contexts.values()) {
      try {
        const object = await this.evaluate(context, `(${input.resolver.toString()})(document, ${JSON.stringify(input.value)})`, false)
        if (object.objectId && object.subtype !== 'null') matches.push({ context, objectId: object.objectId })
      } catch { /* A resolver only matches its own platform frame. */ }
    }
    if (matches.length !== 1) {
      await Promise.all(matches.map(match => this.command('Runtime.releaseObject', { objectId: match.objectId }, match.context.session).catch(() => {})))
      throw new Error(matches.length ? '识别到多个操作目标，已拒绝点击' : '操作目标已变化，请重新读取页面')
    }
    const { context, objectId } = matches[0]
    const started = Date.now()
    const beforeUrlPath = new URL(this.contents.getURL()).pathname
    this.busy = true
    try {
      await this.command('Page.bringToFront')
      this.contents.focus()
      for (let frame: Context | undefined = context; frame; frame = frame.parent) {
        if (!(await this.visible(frame))) throw new Error('目标框架已隐藏，请重新读取当前页面')
      }
      const dispatched = await this.dispatchTrustedPointer(context, objectId, 'click', {
        enforceBlockedReason: false, previousPointer: input.previousPointer, visualDurationMs: input.visualDurationMs ?? 650,
      })
      const dispatchedAt = new Date().toISOString()
      const afterUrlPath = (() => { try { return new URL(this.contents.getURL()).pathname } catch { return '' } })()
      const receipt: BrowserActionReceipt = {
        receiptId: randomBytes(12).toString('hex'), action: input.action,
        target: { frame: context.key, label: input.label },
        before: { urlPath: beforeUrlPath },
        dispatch: { confirmed: true, at: dispatchedAt, mechanism: 'cdp_input', trustedInput: true },
        presentation: { cursorShown: true, purpose: 'visualization_only', target: dispatched.visualPoint ?? dispatched.point },
        wait: { requested: false, satisfied: true, elapsedMs: 0, evidence: '已确认目标收到 isTrusted 点击事件；业务结果需由调用方继续验证' },
        after: { urlPath: afterUrlPath }, durationMs: Date.now() - started,
      }
      return { pointer: dispatched.visualPoint ?? dispatched.point, receipt }
    } finally {
      await this.evaluate(context, `(() => {
        document.querySelectorAll('[data-agenthr-visual="border"]').forEach(node=>node.remove());
        const registry=globalThis.${state};
        if(registry?.clickListener){document.removeEventListener('click',registry.clickListener,true);delete registry.clickListener;}
      })()`).catch(() => {})
      await this.command('Runtime.releaseObject', { objectId }, context.session).catch(() => {})
      this.busy = false
    }
  }

  async act(input: { snapshotId: string; action: string; ref?: string; value?: string; frame?: string; wait?: BrowserWaitCondition }): Promise<{ done: boolean; action: string; verified: boolean; verification: string; receipt: BrowserActionReceipt }> {
    if (this.busy) throw new Error('浏览器操作进行中，请等待完成')
    if (!this.snapshotId || input.snapshotId !== this.snapshotId || this.contents.getURL() !== this.snapshotUrl) throw new Error('页面快照已过期，请重新读取')
    const scrolling = input.action === 'scroll_up' || input.action === 'scroll_down'
    const key = scrolling ? input.frame || 'main' : input.ref?.split(':n')[0]
    const context = key ? this.contexts.get(key) : undefined
    const signature = input.ref ? this.signatures.get(input.ref) : undefined
    if (!context || (!scrolling && !signature)) throw new Error('控件或框架引用无效，请重新读取')
    const started = Date.now()
    const startedAt = new Date(started).toISOString()
    const beforeUrlPath = new URL(this.contents.getURL()).pathname
    const beforeControl = input.ref ? this.controls.get(input.ref) : undefined
    const summarizeControl = (control: BrowserControl | undefined): Partial<BrowserControl> | undefined => control ? {
      ref: control.ref, kind: control.kind, label: control.label, value: control.value, checked: control.checked, expanded: control.expanded,
    } : undefined
    const inspectControl = async (ref: string): Promise<BrowserControl | undefined> => {
      const targetContext = this.contexts.get(ref.split(':n')[0])
      if (!targetContext) return undefined
      return this.evaluate(targetContext, `(${inspectBrowserFrame.toString()})(document, ${JSON.stringify(targetContext.key)}, globalThis.${state}).controls.find(control => control.ref === ${JSON.stringify(ref)})`)
    }
    const currentPath = (): string => { try { return new URL(this.contents.getURL()).pathname } catch { return '' } }
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
        const markBrowserVisualDispatched = ${markBrowserVisualDispatched.toString()};
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
          await this.dispatchTrustedPointer(context, objectId, input.action, { enforceBlockedReason: true })
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
      const dispatchedAt = new Date().toISOString()
      const waitStarted = Date.now()
      const wait = input.wait
      const timeoutMs = wait?.timeoutMs ?? 3_000
      let satisfied = !wait
      let evidence = wait ? '等待条件尚未满足' : '未请求等待条件；仅确认输入事件已发送'
      const checkWait = async (): Promise<{ satisfied: boolean; evidence: string }> => {
        if (!wait) return { satisfied: true, evidence }
        if (wait.type === 'url_changed') {
          const path = currentPath()
          return { satisfied: path !== beforeUrlPath, evidence: `当前路径：${path || '不可用'}；动作前：${beforeUrlPath}` }
        }
        if (wait.type === 'url_path') {
          const path = currentPath()
          return { satisfied: path === wait.value, evidence: `当前路径：${path || '不可用'}` }
        }
        if (wait.type === 'text_contains' || wait.type === 'text_absent') {
          const waitContext = this.contexts.get(wait.frame || context.key)
          if (!waitContext) return { satisfied: false, evidence: '等待目标框架不可用' }
          try {
            const text = String(await this.evaluate(waitContext, `(${inspectBrowserFrame.toString()})(document, ${JSON.stringify(waitContext.key)}, globalThis.${state}).text`))
            const present = text.includes(wait.value)
            return { satisfied: wait.type === 'text_contains' ? present : !present, evidence: `文本“${wait.value}”${present ? '已出现' : '未出现'}` }
          } catch { return { satisfied: false, evidence: '页面执行上下文已变化，请重新读取快照' } }
        }
        let control: BrowserControl | undefined
        try { control = await inspectControl(wait.ref) } catch { control = undefined }
        if (wait.type === 'control_present' || wait.type === 'control_absent') {
          const present = Boolean(control)
          return { satisfied: wait.type === 'control_present' ? present : !present, evidence: `控件 ${wait.ref} ${present ? '存在' : '不存在'}` }
        }
        if (!control) return { satisfied: false, evidence: `控件 ${wait.ref} 不可用` }
        if (wait.type === 'control_value') return { satisfied: control.value === wait.value, evidence: `当前值：${control.value ?? ''}` }
        const actual = wait.state === 'checked' ? control.checked : control.expanded
        return { satisfied: String(actual) === String(wait.value), evidence: `${wait.state}：${String(actual)}` }
      }
      do {
        const result = await checkWait()
        satisfied = result.satisfied
        evidence = result.evidence
        if (satisfied || !wait || Date.now() - waitStarted >= timeoutMs) break
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      } while (true)
      let afterControl: BrowserControl | undefined
      if (input.ref) try { afterControl = await inspectControl(input.ref) } catch { /* navigation invalidated the old context */ }
      const receipt: BrowserActionReceipt = {
        receiptId: randomBytes(12).toString('hex'), action: input.action,
        target: { ...(input.ref ? { ref: input.ref } : {}), frame: context.key, ...(beforeControl?.label ? { label: beforeControl.label } : {}), ...(beforeControl?.kind ? { kind: beforeControl.kind } : {}) },
        before: { urlPath: beforeUrlPath, ...(beforeControl ? { control: summarizeControl(beforeControl) } : {}) },
        dispatch: { confirmed: true, at: dispatchedAt,
          mechanism: input.action === 'select' || scrolling ? 'dom_api' : 'cdp_input',
          trustedInput: input.action !== 'select' && !scrolling },
        presentation: { cursorShown: Boolean(prepared.pointer), purpose: 'visualization_only', ...(prepared.pointer ? { target: prepared.pointer } : {}) },
        wait: { requested: Boolean(wait), ...(wait ? { condition: wait } : {}), satisfied, elapsedMs: Date.now() - waitStarted, evidence },
        after: { urlPath: currentPath(), ...(afterControl ? { control: summarizeControl(afterControl) } : {}) }, durationMs: Date.now() - started,
      }
      return { done: true, action: input.action, verified: satisfied,
        verification: satisfied ? (wait ? `动作已执行且等待条件已满足：${evidence}` : '动作输入已确认发送；未请求业务状态等待条件。') : `动作输入已发送，但等待条件超时：${evidence}。请读取新快照诊断，不要直接重复动作。`, receipt }
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
