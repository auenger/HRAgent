import type { CandidatePreview } from './liepin.js'

export interface BossGreetingInput extends CandidatePreview { platform: 'boss' }
export type BossGreetingTargetState = 'ready' | 'already_contacted' | 'unavailable'

/** Read-only business check used before trusted input dispatch. */
export function inspectBossGreetingTarget(doc: Document, input: BossGreetingInput): BossGreetingTargetState {
  const visibleCard = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hidden || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim()
  const matches = Array.from(doc.querySelectorAll<HTMLElement>('.card-list .candidate-card-wrap, .recommend-card-list .candidate-card-wrap'))
    .filter((candidate, index) => index === input.cardIndex && visibleCard(candidate)
      && normalize(candidate.querySelector('.name')?.textContent ?? '') === normalize(input.name)
      && (!input.skills || normalize(candidate.textContent ?? '').includes(normalize(input.skills)))
      && (!input.summary || normalize(candidate.textContent ?? '').includes(normalize(input.summary))))
  const card = matches.length === 1 ? matches[0] : null
  if (!card) return 'unavailable'
  const visible = (element: HTMLElement): boolean => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true'
  }
  const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim()
  const already = Array.from(card.querySelectorAll<HTMLElement>('.btn.btn-continue, .btn-outline'))
    .some(button => visible(button) && /继续沟通|已沟通|沟通中/iu.test(normalized(button.textContent ?? '')))
  if (already) return 'already_contacted'
  const buttons = Array.from(card.querySelectorAll<HTMLElement>('.btn.btn-greet, .btn.btn-getcontact'))
    .filter(button => visible(button) && !button.matches(':disabled, [aria-disabled="true"]'))
  return buttons.length === 1 ? 'ready' : 'unavailable'
}

/** Returns the uniquely re-matched button; CdpBrowser performs the actual click. */
export function resolveBossGreetingTarget(doc: Document, input: BossGreetingInput): HTMLElement | null {
  const visible = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hidden || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim()
  const cards = Array.from(doc.querySelectorAll<HTMLElement>('.card-list .candidate-card-wrap, .recommend-card-list .candidate-card-wrap'))
    .filter((card, index) => index === input.cardIndex && visible(card)
      && normalized(card.querySelector('.name')?.textContent ?? '') === normalized(input.name)
      && (!input.skills || normalized(card.textContent ?? '').includes(normalized(input.skills)))
      && (!input.summary || normalized(card.textContent ?? '').includes(normalized(input.summary))))
  if (cards.length !== 1) return null
  const card = cards[0]
  const already = Array.from(card.querySelectorAll<HTMLElement>('.btn.btn-continue, .btn-outline'))
    .some(button => visible(button) && /继续沟通|已沟通|沟通中/iu.test(normalized(button.textContent ?? '')))
  if (already) return null
  const buttons = Array.from(card.querySelectorAll<HTMLElement>('.btn.btn-greet, .btn.btn-getcontact'))
    .filter(button => visible(button) && !button.matches(':disabled, [aria-disabled="true"]'))
  return buttons.length === 1 ? buttons[0] : null
}

/** Resolves the only visible close control for an open BOSS resume detail. */
export function resolveBossDetailCloseTarget(doc: Document): HTMLElement | null {
  const visible = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hidden || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('.boss-popup__close, .resume-custom-close')).filter(visible)
  return buttons.length === 1 ? buttons[0] : null
}
