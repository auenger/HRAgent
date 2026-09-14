import type { CandidatePreview, OpenResume } from './liepin.js'

/** GoodHR5's BOSS selectors are a starting point; live pages require recruiter validation. */
export function extractBossPreviews(doc: Document): CandidatePreview[] {
  const cards = Array.from(doc.querySelectorAll<HTMLElement>(
    '.card-list .candidate-card-wrap, .recommend-card-list .candidate-card-wrap',
  )).filter(card => {
    const style = doc.defaultView?.getComputedStyle?.(card)
    return !card.hasAttribute('hidden') && card.getAttribute('aria-hidden') !== 'true'
      && style?.display !== 'none' && style?.visibility !== 'hidden'
  }).slice(0, 30)
  const read = (card: HTMLElement, selector: string, limit: number): string =>
    (card.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
  return cards.map((card, cardIndex) => ({
    cardIndex,
    name: read(card, '.name', 120),
    skills: read(card, '.base-info.join-text-wrap, .geek-info-detail', 1200),
    summary: read(card, '.content.join-text-wrap, .content, .job-card-left', 1600),
  })).filter(card => card.name !== '' || card.skills !== '' || card.summary !== '')
}

/** A BOSS detail can remain mounted after closing; require one visible detail iframe. */
export function hasSingleVisibleBossResumeFrame(doc: Document): boolean {
  const frames = Array.from(doc.querySelectorAll<HTMLElement>("iframe[src*='/web/frame/c-resume/']"))
    .filter(frame => {
      const style = doc.defaultView?.getComputedStyle?.(frame)
      return !frame.hasAttribute('hidden') && frame.getAttribute('aria-hidden') !== 'true'
        && style?.display !== 'none' && style?.visibility !== 'hidden'
    })
  return frames.length === 1
}

/** Run only inside the single manually opened BOSS resume frame. */
export function extractOpenBossResume(doc: Document): OpenResume | null {
  const roots = Array.from(doc.querySelectorAll<HTMLElement>('#resume')).filter(root => {
    const style = doc.defaultView?.getComputedStyle?.(root)
    return !root.hasAttribute('hidden') && root.getAttribute('aria-hidden') !== 'true'
      && style?.display !== 'none' && style?.visibility !== 'hidden'
  })
  if (roots.length !== 1) return null
  const root = roots[0]
  const text = (root.innerText || root.textContent || '').replace(/\r/gu, '').replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n').trim().slice(0, 20_000)
  if (text.length < 20) return null
  const name = (root.querySelector('.name, .resume-name, [class*="name"]')?.textContent ?? '')
    .replace(/\s+/gu, ' ').trim().slice(0, 120)
  return { name, text }
}
