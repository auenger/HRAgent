import { beginBrowserVisual, type PointerPoint } from './browser-visual.js'

export interface BrowserControl {
  ref: string
  kind: 'search_input' | 'button' | 'link'
  label: string
  signature: string
}

export interface BrowserFrameSnapshot {
  frame: string
  title: string
  text: string
  controls: BrowserControl[]
}

export type BrowserUseAction =
  | { type: 'fill'; ref: string; value: string }
  | { type: 'press_enter'; ref: string }
  | { type: 'click'; ref: string }
  | { type: 'scroll'; direction: 'up' | 'down' }

/** This function runs in the recruitment renderer and has no Node dependency. */
export function inspectBrowserFrame(doc: Document, frame: string): BrowserFrameSnapshot {
  const compact = (value: string, limit: number): string => value.replace(/\s+/gu, ' ').trim().slice(0, limit)
  const visible = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const controls: BrowserControl[] = []
  const elements = Array.from(doc.querySelectorAll<HTMLElement>('input, button, a, [role="button"]')).slice(0, 500)
  for (let index = 0; index < elements.length && controls.length < 100; index++) {
    const element = elements[index]
    if (!visible(element) || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') continue
    const tag = element.tagName.toLowerCase()
    const rawLabel = [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('title'), element.textContent].find(value => value?.trim()) ?? ''
    const label = compact(rawLabel, 120)
    const identifier = compact([element.getAttribute('name'), element.id, element.getAttribute('role')].filter(Boolean).join(' '), 100)
    let kind: BrowserControl['kind']
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (!['text', 'search'].includes(type) || !/搜索|搜|职位|岗位|关键词|关键字|keyword|search|job|position|role/iu.test(`${label} ${identifier} ${type === 'search' ? 'search' : ''}`)) continue
      kind = 'search_input'
    } else if (tag === 'a') {
      if (!element.getAttribute('href') || !label) continue
      kind = 'link'
    } else {
      if (!label) continue
      kind = 'button'
    }
    if (/沟通|联系|私信|发消息|发送|打招呼|聊天|邀约|邀请|投递|推荐给|收藏|chat|contact|message|send|greet|invite|apply|submit|favorite/iu.test(`${label} ${identifier}`)) continue
    const href = kind === 'link' ? compact(element.getAttribute('href') || '', 200) : ''
    controls.push({ ref: `${frame}:e${index}`, kind, label: label || identifier || '搜索输入框', signature: `${tag}|${kind}|${label}|${identifier}|${href}` })
  }
  const body = doc.body
  const rawText = body?.innerText || body?.textContent || ''
  const text = compact(rawText, 16_000)
  return { frame, title: compact(doc.title || '', 200), text, controls }
}

/** Re-inspects a frozen page reference before acting. No arbitrary selector or script reaches this function. */
export async function actOnBrowserFrame(doc: Document, action: BrowserUseAction, expectedSignature: string, durationMs = 1050, previous: PointerPoint | null = null): Promise<{ done: boolean; action: string; pointer?: PointerPoint }> {
  if (action.type === 'scroll') {
    const visual = await beginBrowserVisual(doc, null, previous, durationMs)
    try {
      doc.defaultView?.scrollBy?.({ top: action.direction === 'down' ? 520 : -520, behavior: 'smooth' })
      return { done: true, action: `scroll_${action.direction}`, pointer: visual.point }
    } finally { visual.border.remove() }
  }
  const frame = action.ref.split(':e')[0]
  const snapshot = inspectBrowserFrame(doc, frame)
  const control = snapshot.controls.find(item => item.ref === action.ref && item.signature === expectedSignature)
  if (!control) return { done: false, action: 'stale_reference' }
  const index = Number(action.ref.split(':e')[1])
  const element = Array.from(doc.querySelectorAll<HTMLElement>('input, button, a, [role="button"]'))[index]
  if (!element) return { done: false, action: 'stale_reference' }
  if (action.type === 'fill' && control.kind !== 'search_input') return { done: false, action: 'not_search_input' }
  if (action.type === 'press_enter' && control.kind !== 'search_input') return { done: false, action: 'not_search_input' }
  if (action.type === 'click') {
    if (control.kind === 'search_input') return { done: false, action: 'not_clickable' }
    if (control.kind === 'button' && !/搜索|查询|筛选|过滤|确定|应用|下一页|上一页|候选|简历|查看|详情|薪资|工资|期望|意向|search|filter|next|previous|resume|detail|salary|intent/iu.test(control.label)) {
      return { done: false, action: 'button_not_allowed' }
    }
    if (control.kind === 'link') {
      const href = element.getAttribute('href') || ''
      const url = new URL(href, doc.location?.href || 'https://invalid.local')
      const currentHost = doc.location?.hostname || ''
      const domain = currentHost === 'liepin.com' || currentHost.endsWith('.liepin.com') ? 'liepin.com'
        : currentHost === 'zhipin.com' || currentHost.endsWith('.zhipin.com') ? 'zhipin.com' : ''
      if (href.startsWith('#') || url.protocol !== 'https:' || !domain || (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
        || /\/chat(?:\/|$)|\/message(?:\/|$)|\/invite(?:\/|$)|\/apply(?:\/|$)/iu.test(url.pathname)) {
        return { done: false, action: 'link_not_allowed' }
      }
    }
  }
  const visual = await beginBrowserVisual(doc, element, previous, durationMs)
  try {
    if (durationMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, 260))
    if (action.type === 'fill') {
      const input = element as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(doc.defaultView?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype, 'value')?.set
      if (!setter) return { done: false, action: 'input_unavailable' }
      setter.call(input, action.value)
      const EventConstructor = doc.defaultView?.Event ?? Event
      input.dispatchEvent(new EventConstructor('input', { bubbles: true }))
      input.dispatchEvent(new EventConstructor('change', { bubbles: true }))
      input.focus()
    } else if (action.type === 'press_enter') {
      const input = element as HTMLInputElement
      input.focus()
    } else {
      element.click()
    }
    return { done: true, action: action.type, pointer: visual.point }
  } finally {
    visual.border.remove()
  }
}
