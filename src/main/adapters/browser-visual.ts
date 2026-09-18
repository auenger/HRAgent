export interface PointerPoint { x: number; y: number }

export type BrowserVisualPhase = 'idle' | 'moving' | 'targeted' | 'dispatched'

/** Runs inside a site frame; its pointer remains until the next browser operation. */
export function restoreBrowserPointer(doc: Document, point: PointerPoint): HTMLElement {
  let pointer = doc.querySelector<HTMLElement>('[data-agenthr-visual="pointer"]')
  if (!pointer) {
    pointer = doc.createElement('div')
    pointer.setAttribute('data-agenthr-visual', 'pointer')
    pointer.setAttribute('data-agenthr-phase', 'idle')
    pointer.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:28px;z-index:2147483647;pointer-events:none;transition:transform 160ms cubic-bezier(.22,.7,.18,1);filter:drop-shadow(0 0 4px rgba(98,202,255,.75)) drop-shadow(0 0 9px rgba(178,124,255,.5));'
    pointer.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="28" viewBox="0 0 20 28" aria-hidden="true"><defs><linearGradient id="agenthr-cursor-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#70dcff"/><stop offset=".55" stop-color="#a88fff"/><stop offset="1" stop-color="#f3a6dc"/></linearGradient></defs><path d="M3.5 2.5 Q2.5 2 2.5 3.5 L2.5 21 Q2.5 22.5 3.8 21.5 L8.3 17.3 L12.2 25 Q12.7 26 13.7 25.5 L15.5 24.6 Q16.5 24.2 16 23.2 L12.2 16.5 L18 16.5 Q19.4 16.5 18.3 15.5 Z" fill="#20242b" stroke="url(#agenthr-cursor-gradient)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>'
    doc.body.append(pointer)
  }
  pointer.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`
  return pointer
}

/** Presentation only: action success must always come from the runtime receipt. */
export function markBrowserVisualDispatched(doc: Document): void {
  const pointer = doc.querySelector<HTMLElement>('[data-agenthr-visual="pointer"]')
  if (!pointer) return
  pointer.setAttribute('data-agenthr-phase', 'dispatched')
  pointer.style.filter = 'drop-shadow(0 0 5px rgba(98,202,255,.95)) drop-shadow(0 0 13px rgba(178,124,255,.82))'
}

export async function beginBrowserVisual(doc: Document, target: HTMLElement | null, previous: PointerPoint | null, durationMs = 1050): Promise<{ point: PointerPoint; border: HTMLElement }> {
  const view = doc.defaultView
  const first = previous ?? { x: Math.max(24, Math.round((view?.innerWidth ?? 700) * .48)), y: Math.max(24, Math.round((view?.innerHeight ?? 500) * .5)) }
  const pointer = restoreBrowserPointer(doc, first)
  const movementMs = Math.max(0, Math.min(durationMs, 180))
  pointer.style.transitionDuration = `${movementMs}ms`
  pointer.setAttribute('data-agenthr-phase', 'moving')
  const border = doc.createElement('div')
  border.setAttribute('data-agenthr-visual', 'border')
  border.style.cssText = 'position:fixed;inset:7px;border-radius:14px;background:linear-gradient(90deg,#70dcff,#ae95ff,#efa9dc) top/100% 2px no-repeat,linear-gradient(90deg,#efa9dc,#ae95ff,#70dcff) bottom/100% 2px no-repeat,linear-gradient(180deg,#70dcff,#ae95ff) left/2px 100% no-repeat,linear-gradient(180deg,#efa9dc,#70dcff) right/2px 100% no-repeat;box-shadow:0 0 18px rgba(101,190,255,.32),0 0 34px rgba(177,120,255,.18);z-index:2147483646;pointer-events:none;opacity:.9;'
  doc.body.append(border)
  target?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
  const rect = target?.getBoundingClientRect?.()
  const point = rect
    ? { x: Math.max(12, Math.round(rect.left + rect.width / 2)), y: Math.max(12, Math.round(rect.top + rect.height / 2)) }
    : { x: Math.max(24, Math.round((view?.innerWidth ?? 700) - 70)), y: Math.max(24, Math.round((view?.innerHeight ?? 500) / 2)) }
  pointer.getBoundingClientRect?.()
  pointer.style.transform = `translate(${point.x}px, ${point.y}px)`
  await new Promise(resolveWait => setTimeout(resolveWait, movementMs))
  pointer.setAttribute('data-agenthr-phase', 'targeted')
  return { point, border }
}
