import { beginBrowserVisual, type PointerPoint } from './browser-visual.js'

export interface BrowserControl {
  ref: string
  kind: 'text_input' | 'select' | 'checkbox' | 'radio' | 'button' | 'link' | 'tab' | 'option'
  label: string
  signature: string
  value?: string
  options?: Array<{ value: string; label: string }>
  blockedReason?: string
  expanded?: string
  checked?: boolean
}

export interface BrowserNodeRegistry {
  nodes: Map<string, HTMLElement>
  ids: WeakMap<HTMLElement, string>
  next: number
  extras?: Set<HTMLElement>
  names?: WeakMap<HTMLElement, string>
  blocked?: WeakMap<HTMLElement, string>
}

export interface BrowserFrameSnapshot {
  frame: string
  title: string
  text: string
  controls: BrowserControl[]
}

export type BrowserUseAction =
  | { type: 'fill'; ref: string; value: string }
  | { type: 'select'; ref: string; value: string }
  | { type: 'press_enter'; ref: string }
  | { type: 'click'; ref: string }
  | { type: 'hover'; ref: string }
  | { type: 'scroll'; direction: 'up' | 'down' }

/** This function runs in the recruitment renderer and has no Node dependency. */
export function inspectBrowserFrame(doc: Document, frame: string, registry?: BrowserNodeRegistry): BrowserFrameSnapshot {
  const compact = (value: string, limit: number): string => value.replace(/\s+/gu, ' ').trim().slice(0, limit)
  const visible = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const controls: BrowserControl[] = []
  const selector = 'input, textarea, select, button, a, [role], [aria-haspopup], [aria-expanded], [aria-controls], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [onclick]'
  const elements: HTMLElement[] = []
  const scan = (root: Document | ShadowRoot) => {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*')).slice(0, 12000)) {
      if (element.closest('[data-agenthr-visual], [data-agenthr-control-shield]')) continue
      const customPointer = registry && doc.defaultView?.getComputedStyle?.(element).cursor === 'pointer'
        && (!element.parentElement || doc.defaultView?.getComputedStyle?.(element.parentElement).cursor !== 'pointer')
      if (element.matches(selector) || customPointer) elements.push(element)
      if (element.shadowRoot) scan(element.shadowRoot)
    }
  }
  scan(doc)
  if (registry?.extras) for (const element of registry.extras) if (element.isConnected && !elements.includes(element)) elements.push(element)
  if (registry) for (const [ref, node] of registry.nodes) if (!node.isConnected) registry.nodes.delete(ref)
  if (registry) {
    const overlaySelector = '[role="dialog"], [role="tooltip"], .ant-modal, .ant-drawer, .ant-popover, [class*="modal"], [class*="drawer"], [class*="popover"], [class*="tooltip"]'
    const priority = (element: HTMLElement): number => {
      const hint = compact([
        element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('alt'),
        registry.names?.get(element), element.textContent,
      ].find(value => value?.trim()) ?? '', 160)
      let score = element.closest(overlaySelector) ? 100 : 0
      if (/^(?:我知道了|知道了|关闭|close|dismiss|got it)$/iu.test(hint)) score += 40
      try {
        const rect = element.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
          && rect.top < (doc.defaultView?.innerHeight ?? Number.MAX_SAFE_INTEGER)
          && rect.left < (doc.defaultView?.innerWidth ?? Number.MAX_SAFE_INTEGER)) score += 10
        const root = element.getRootNode() as Document | ShadowRoot
        const hit = 'elementFromPoint' in root ? root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
        if (hit && (hit === element || element.contains(hit))) score += 20
      } catch { /* DOM-only tests and unusual SVG nodes may not expose layout. */ }
      return score
    }
    // Portals for dialogs and tutorials are commonly appended after hundreds of page
    // controls. Put their actionable controls first so the bounded snapshot keeps them.
    elements.sort((left, right) => priority(right) - priority(left))
  }
  for (let index = 0; index < elements.length && controls.length < 300; index++) {
    const element = elements[index]
    if (!visible(element) || (registry && !element.getClientRects().length) || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') continue
    const tag = element.tagName.toLowerCase()
    const role = (element.getAttribute('role') || '').toLowerCase()
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean).map(id => doc.getElementById(id)?.textContent || '').join(' ')
    const nativeLabel = Array.from((element as HTMLInputElement).labels || []).map(label => label.textContent).join(' ')
    const iconLabel = /(?:^|[-_\s])close(?:$|[-_\s])/iu.test(element.className?.toString() || '') ? '关闭' : ''
    const rawLabel = [element.getAttribute('aria-label'), labelledBy, nativeLabel, element.getAttribute('placeholder'), element.getAttribute('title'),
      element.getAttribute('name'), element.textContent, registry?.names?.get(element), iconLabel].find(value => value?.trim()) ?? ''
    const label = compact(rawLabel, 160) || `${tag} ${index + 1}`
    const identifier = compact([element.getAttribute('name'), element.id, role].filter(Boolean).join(' '), 120)
    const inputType = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : ''
    if (tag === 'input' && inputType === 'hidden') continue
    let kind: BrowserControl['kind']
    if (tag === 'select') kind = 'select'
    else if (tag === 'textarea' || element.getAttribute('contenteditable') === 'true'
      || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(inputType))) kind = 'text_input'
    else if ((tag === 'input' && inputType === 'checkbox') || role === 'checkbox' || role === 'switch') kind = 'checkbox'
    else if ((tag === 'input' && inputType === 'radio') || role === 'radio') kind = 'radio'
    else if (role === 'tab') kind = 'tab'
    else if (['option', 'menuitem', 'treeitem'].includes(role)) kind = 'option'
    else if (tag === 'a' || role === 'link') kind = 'link'
    else kind = 'button'

    const context = `${label} ${identifier}`
    let blockedReason: string | undefined
    if ((tag === 'input' && inputType === 'password') || (kind === 'text_input' && /验证码|verification code|one.?time code|otp/iu.test(context))) blockedReason = '密码和验证码需要人工输入'
    else if (tag === 'input' && inputType === 'file') blockedReason = '上传文件需要用户授权'
    else if (/私信|发消息|发送(?:消息|验证码)?|打招呼|立即沟通|发起沟通|开始沟通|联系候选人|联系TA|邀约|邀请面试|投递|申请职位|立即申请|推荐给|send message|greet|invite|apply now|submit application|contact candidate/iu.test(context)) blockedReason = '对外联系或提交需要用户授权'
    else if (/删除|移除|清空|注销|delete|remove|clear all|destroy/iu.test(context)) blockedReason = '删除操作需要用户授权'
    else if (/下载|导出|download|export/iu.test(context) || element.hasAttribute('download')) blockedReason = '下载或导出文件需要用户授权'
    if (registry?.blocked) {
      if (blockedReason) registry.blocked.set(element, blockedReason)
      else registry.blocked.delete(element)
    }

    const href = kind === 'link' ? compact(element.getAttribute('href') || '', 300) : ''
    const value = (kind === 'text_input' || kind === 'select') && inputType !== 'password' ? compact((element as HTMLInputElement).value || '', 300) : undefined
    const options = kind === 'select' ? Array.from((element as HTMLSelectElement).options).slice(0, 100).map(option => ({
      value: option.value.slice(0, 200), label: compact(option.textContent || option.label || option.value, 160),
    })) : undefined
    let ref = `${frame}:e${index}`
    if (registry) {
      ref = registry.ids.get(element) || `${frame}:n${++registry.next}`
      registry.ids.set(element, ref)
      registry.nodes.set(ref, element)
    }
    controls.push({ ref, kind, label, signature: `${tag}|${inputType}|${kind}|${label}|${identifier}|${href}`, value, options, blockedReason,
      expanded: element.getAttribute('aria-expanded') ?? undefined,
      checked: kind === 'checkbox' || kind === 'radio' ? ((element as HTMLInputElement).checked ?? element.getAttribute('aria-checked') === 'true') : undefined })
  }
  const body = doc.body
  const rawText = body?.innerText || body?.textContent || ''
  const text = compact(rawText, 24_000)
  return { frame, title: compact(doc.title || '', 200), text, controls }
}

/** Re-inspects a frozen page reference before acting. No arbitrary selector or script reaches this function. */
export async function actOnBrowserFrame(doc: Document, action: BrowserUseAction, expectedSignature: string, durationMs = 1050, previous: PointerPoint | null = null, registry?: BrowserNodeRegistry, prepareOnly = false): Promise<{ done: boolean; action: string; reason?: string; pointer?: PointerPoint }> {
  if (action.type === 'scroll') {
    const visual = await beginBrowserVisual(doc, null, previous, durationMs)
    try {
      doc.defaultView?.scrollBy?.({ top: action.direction === 'down' ? 520 : -520, behavior: 'smooth' })
      return { done: true, action: `scroll_${action.direction}`, pointer: visual.point }
    } finally { visual.border.remove() }
  }
  const frame = action.ref.split(/:[en]/u)[0]
  const snapshot = inspectBrowserFrame(doc, frame, registry)
  const control = snapshot.controls.find(item => item.ref === action.ref && item.signature === expectedSignature)
  if (!control) return { done: false, action: 'stale_reference', reason: '页面元素已经变化' }
  if (control.blockedReason) return { done: false, action: 'authorization_required', reason: control.blockedReason }
  const index = Number(action.ref.split(':e')[1])
  const selector = 'input, textarea, select, button, a, [role], [aria-haspopup], [aria-expanded], [aria-controls], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [onclick]'
  const element = registry ? registry.nodes.get(action.ref) : Array.from(doc.querySelectorAll<HTMLElement>(selector))[index]
  if (!element) return { done: false, action: 'stale_reference', reason: '页面元素已经变化' }
  if ((action.type === 'fill' || action.type === 'press_enter') && control.kind !== 'text_input') {
    return { done: false, action: 'wrong_control_type', reason: '该元素不是文本输入框' }
  }
  if (action.type === 'select' && control.kind !== 'select') {
    return { done: false, action: 'wrong_control_type', reason: '该元素不是下拉选择框' }
  }
  if (action.type === 'click' && control.kind === 'link') {
    const href = element.getAttribute('href') || ''
    const url = new URL(href, doc.location?.href || 'https://invalid.local')
    const currentHost = doc.location?.hostname || ''
    const domain = currentHost === 'liepin.com' || currentHost.endsWith('.liepin.com') ? 'liepin.com'
      : currentHost === 'zhipin.com' || currentHost.endsWith('.zhipin.com') ? 'zhipin.com' : ''
    const sameDocumentAction = !href || href.startsWith('#') || /^javascript:\s*(?:;|void\s*\(\s*0\s*\)\s*;?)?$/iu.test(href)
    if (!sameDocumentAction && (url.protocol !== 'https:' || !domain || (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)))) {
      return { done: false, action: 'external_navigation_blocked', reason: '站外跳转需要人工操作' }
    }
  }
  const visual = await beginBrowserVisual(doc, element, previous, durationMs)
  try {
    if (prepareOnly) return { done: true, action: action.type, pointer: visual.point }
    if (durationMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, 260))
    if (action.type === 'fill') {
      if (element.getAttribute('contenteditable') === 'true') element.textContent = action.value
      else {
        const input = element as HTMLInputElement | HTMLTextAreaElement
        const prototype = element.tagName.toLowerCase() === 'textarea'
          ? doc.defaultView?.HTMLTextAreaElement?.prototype ?? HTMLTextAreaElement.prototype
          : doc.defaultView?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter) return { done: false, action: 'input_unavailable', reason: '输入框当前不可写' }
        setter.call(input, action.value)
      }
      const EventConstructor = doc.defaultView?.Event ?? Event
      element.dispatchEvent(new EventConstructor('input', { bubbles: true }))
      element.dispatchEvent(new EventConstructor('change', { bubbles: true }))
      element.focus()
    } else if (action.type === 'select') {
      const select = element as HTMLSelectElement
      const option = Array.from(select.options).find(candidate => candidate.value === action.value)
      if (!option) {
        return { done: false, action: 'option_unavailable', reason: '下拉选项已经变化' }
      }
      const prototype = doc.defaultView?.HTMLSelectElement?.prototype ?? HTMLSelectElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      if (setter) setter.call(select, action.value)
      else Array.from(select.options).forEach(candidate => {
        if (candidate === option) candidate.setAttribute('selected', '')
        else candidate.removeAttribute('selected')
      })
      const EventConstructor = doc.defaultView?.Event ?? Event
      select.dispatchEvent(new EventConstructor('input', { bubbles: true }))
      select.dispatchEvent(new EventConstructor('change', { bubbles: true }))
    } else if (action.type === 'press_enter') {
      element.focus()
    } else {
      element.click()
    }
    return { done: true, action: action.type, pointer: visual.point }
  } finally {
    visual.border.remove()
  }
}
