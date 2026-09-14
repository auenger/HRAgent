import type { CandidatePreview } from './liepin.js'
import type { Platform } from '../platforms.js'
import { beginBrowserVisual, type PointerPoint } from './browser-visual.js'

/** Runs in the site frame. The only click target is GoodHR5's candidate-detail region. */
export async function animateOpenCandidate(doc: Document, input: CandidatePreview & { platform: Platform }, durationMs = 1100, previous: PointerPoint | null = null): Promise<{ opened: boolean; name: string; pointer?: PointerPoint }> {
  const cardSelector = input.platform === 'boss'
    ? '.card-list .candidate-card-wrap, .recommend-card-list .candidate-card-wrap'
    : "[data-tlg-elem-id='b_pc_home_hp_res_listcard'], [data-tlg-elem-id='b_pc_home_new_res_listcard']"
  const cards = Array.from(doc.querySelectorAll<HTMLElement>(cardSelector)).filter(card => {
    for (let node: HTMLElement | null = card; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }).slice(0, 30)
  const card = cards[input.cardIndex]
  if (!card || !input.name) return { opened: false, name: '' }
  const read = (selector: string, limit: number): string =>
    (card.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
  const actual = input.platform === 'boss'
    ? { name: read('.name', 120), skills: read('.base-info.join-text-wrap, .geek-info-detail', 1200), summary: read('.content.join-text-wrap, .content, .job-card-left', 1600) }
    : { name: read('.nest-resume-personal-name', 120), skills: read('.nest-resume-personal-skills', 1200), summary: read('.resume-description', 1600) }
  if (actual.name !== input.name || actual.skills !== input.skills || actual.summary !== input.summary) {
    return { opened: false, name: '' }
  }
  const target = card.querySelector<HTMLElement>(input.platform === 'boss'
    ? '.base-info.join-text-wrap'
    : "[class*='newResumeLeft--']")
  if (!target || target.closest('.btn-greet, .btn-getcontact, [data-tlg-elem-id*="chat_btn"]')) {
    return { opened: false, name: '' }
  }
  const visual = await beginBrowserVisual(doc, target, previous, durationMs)
  try {
    if (durationMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, 260))
    target.click()
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(durationMs, 450)))
    return { opened: true, name: input.name, pointer: visual.point }
  } finally {
    visual.border.remove()
  }
}
