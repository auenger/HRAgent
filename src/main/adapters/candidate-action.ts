import type { CandidatePreview } from './liepin.js'
import type { Platform } from '../platforms.js'

/** Runs in the site frame. The only click target is GoodHR5's candidate-detail region. */
export async function animateOpenCandidate(doc: Document, input: CandidatePreview & { platform: Platform }, durationMs = 650): Promise<{ opened: boolean; name: string }> {
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
  card.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  const border = doc.createElement('div')
  border.setAttribute('data-agenthr-visual', 'border')
  border.style.cssText = 'position:fixed;inset:4px;border:3px solid #e82127;box-shadow:0 0 0 4px rgba(232,33,39,.25),inset 0 0 24px rgba(232,33,39,.2);border-radius:10px;z-index:2147483646;pointer-events:none;'
  const pointer = doc.createElement('div')
  pointer.setAttribute('data-agenthr-visual', 'pointer')
  pointer.textContent = '➤'
  pointer.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;background:#e82127;color:white;font:22px Arial;box-shadow:0 6px 22px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transition:transform .48s ease-out;'
  doc.body.append(border, pointer)
  try {
    const rect = target.getBoundingClientRect?.()
    const x = rect ? Math.max(12, rect.left + rect.width / 2) : 24
    const y = rect ? Math.max(12, rect.top + rect.height / 2) : 24
    pointer.getBoundingClientRect?.()
    pointer.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    await new Promise(resolveWait => setTimeout(resolveWait, durationMs))
    target.click()
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(durationMs, 450)))
    return { opened: true, name: input.name }
  } finally {
    pointer.remove()
    border.remove()
  }
}
