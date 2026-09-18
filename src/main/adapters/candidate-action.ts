import type { CandidatePreview } from './liepin.js'
import type { Platform } from '../platforms.js'

/**
 * Trusted runtime resolver for the candidate detail region.
 * It deliberately returns an element without clicking it; CdpBrowser owns input dispatch.
 */
export function resolveCandidateDetailTarget(doc: Document, input: CandidatePreview & { platform: Platform }): HTMLElement | null {
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
  if (!card || !input.name) return null
  const read = (selector: string, limit: number): string =>
    (card.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
  const actual = input.platform === 'boss'
    ? { name: read('.name', 120), skills: read('.base-info.join-text-wrap, .geek-info-detail', 1200), summary: read('.content.join-text-wrap, .content, .job-card-left', 1600) }
    : { name: read('.nest-resume-personal-name', 120), skills: read('.nest-resume-personal-skills', 1200), summary: read('.resume-description', 1600) }
  if (actual.name !== input.name || actual.skills !== input.skills || actual.summary !== input.summary) return null
  const target = card.querySelector<HTMLElement>(input.platform === 'boss'
    ? '.base-info.join-text-wrap'
    : "[class*='newResumeLeft--']")
  if (!target || target.closest('.btn-greet, .btn-getcontact, [data-tlg-elem-id*="chat_btn"]')) return null
  return target
}
