export interface PointerPoint { x: number; y: number }

/** Runs inside a site frame; its pointer remains until the next browser operation. */
export function restoreBrowserPointer(doc: Document, point: PointerPoint): HTMLElement {
  let pointer = doc.querySelector<HTMLElement>('[data-agenthr-visual="pointer"]')
  if (!pointer) {
    pointer = doc.createElement('div')
    pointer.setAttribute('data-agenthr-visual', 'pointer')
    pointer.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:40px;z-index:2147483647;pointer-events:none;transition:transform 1.05s cubic-bezier(.22,.7,.18,1);filter:drop-shadow(0 0 7px rgba(98,202,255,.95)) drop-shadow(0 0 15px rgba(178,124,255,.75));'
    pointer.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40" aria-hidden="true"><defs><linearGradient id="agenthr-cursor-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#70dcff"/><stop offset=".55" stop-color="#a88fff"/><stop offset="1" stop-color="#f3a6dc"/></linearGradient></defs><path d="M4 3 L4 31 L11 24 L16 36 L21 34 L16 22 L27 22 Z" fill="#f9fbff" stroke="url(#agenthr-cursor-gradient)" stroke-width="2.4" stroke-linejoin="round"/></svg>'
    doc.body.append(pointer)
  }
  pointer.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`
  return pointer
}

export async function beginBrowserVisual(doc: Document, target: HTMLElement | null, previous: PointerPoint | null, durationMs = 1050): Promise<{ point: PointerPoint; border: HTMLElement }> {
  const view = doc.defaultView
  const first = previous ?? { x: Math.max(24, Math.round((view?.innerWidth ?? 700) * .48)), y: Math.max(24, Math.round((view?.innerHeight ?? 500) * .5)) }
  const pointer = restoreBrowserPointer(doc, first)
  const border = doc.createElement('div')
  border.setAttribute('data-agenthr-visual', 'border')
  border.style.cssText = 'position:fixed;inset:7px;border:2px solid transparent;border-radius:14px;background:linear-gradient(transparent,transparent) padding-box,linear-gradient(135deg,#70dcff,#ae95ff,#efa9dc,#70dcff) border-box;box-shadow:0 0 24px rgba(101,190,255,.36),0 0 42px rgba(177,120,255,.22),inset 0 0 28px rgba(132,149,255,.17);z-index:2147483646;pointer-events:none;opacity:.85;'
  doc.body.append(border)
  target?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
  const rect = target?.getBoundingClientRect?.()
  const point = rect
    ? { x: Math.max(12, Math.round(rect.left + rect.width / 2)), y: Math.max(12, Math.round(rect.top + rect.height / 2)) }
    : { x: Math.max(24, Math.round((view?.innerWidth ?? 700) - 70)), y: Math.max(24, Math.round((view?.innerHeight ?? 500) / 2)) }
  pointer.getBoundingClientRect?.()
  pointer.style.transform = `translate(${point.x}px, ${point.y}px)`
  await new Promise(resolveWait => setTimeout(resolveWait, durationMs))
  return { point, border }
}
