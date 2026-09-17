import type { CandidatePreview } from './liepin.js'
import type { PointerPoint } from './browser-visual.js'

export interface BossGreetingInput extends CandidatePreview {
  platform: 'boss'
}

export interface BossGreetingResult {
  greeted: boolean
  alreadyContacted: boolean
  name: string
  pointer?: PointerPoint
}

/**
 * Runs only after the main process re-read and uniquely matched the candidate card.
 * The caller supplies the visual helpers so this remains serializable in a site frame.
 */
export async function animateBossGreeting(
  doc: Document,
  input: BossGreetingInput,
  delayMs: number,
  previousPointer: PointerPoint | null,
  beginVisual?: (doc: Document, target: HTMLElement, previous: PointerPoint | null, delay: number) => Promise<{ point?: PointerPoint }>,
): Promise<BossGreetingResult> {
  const visible = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hidden || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const cards = Array.from(doc.querySelectorAll<HTMLElement>(
    '.card-list .candidate-card-wrap, .recommend-card-list .candidate-card-wrap',
  )).filter(card => visible(card))
  const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim()
  const expectedName = normalized(input.name)
  const matches = cards.filter((card, index) => {
    if (index !== input.cardIndex) return false
    const name = normalized(card.querySelector('.name')?.textContent ?? '')
    const text = normalized(card.textContent ?? '')
    return name === expectedName && (!input.skills || text.includes(normalized(input.skills)))
      && (!input.summary || text.includes(normalized(input.summary)))
  })
  if (matches.length !== 1) return { greeted: false, alreadyContacted: false, name: expectedName }
  const card = matches[0]
  const already = Array.from(card.querySelectorAll<HTMLElement>('.btn.btn-continue, .btn-outline'))
    .some(button => visible(button) && /继续沟通|已沟通|沟通中/iu.test(normalized(button.textContent ?? '')))
  if (already) return { greeted: false, alreadyContacted: true, name: expectedName }
  const buttons = Array.from(card.querySelectorAll<HTMLElement>('.btn.btn-greet, .btn.btn-getcontact'))
    .filter(button => visible(button) && !button.matches(':disabled, [aria-disabled="true"]'))
  if (buttons.length !== 1) return { greeted: false, alreadyContacted: false, name: expectedName }
  const target = buttons[0]
  const visual = beginVisual ? await beginVisual(doc, target, previousPointer, delayMs) : {}
  target.click()
  return { greeted: true, alreadyContacted: false, name: expectedName, pointer: visual.point }
}
