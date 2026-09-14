/** One card on the currently loaded page. The index is ephemeral and must never identify a message recipient. */
export interface CandidatePreview {
  cardIndex: number
  name: string
  skills: string
  summary: string
}

/** Detail that the recruiter opened manually; no card index or inferred identity. */
export interface OpenResume {
  name: string
  text: string
}

/**
 * Read-only extraction based on GoodHR's Liepin card selectors. This function is
 * self-contained so its source can run in the isolated recruitment renderer.
 * These selectors are a starting point and require validation by the user.
 */
export function extractLiepinPreviews(doc: Document): CandidatePreview[] {
  const cards = Array.from(doc.querySelectorAll<HTMLElement>(
    "[data-tlg-elem-id='b_pc_home_hp_res_listcard'], [data-tlg-elem-id='b_pc_home_new_res_listcard']",
  )).slice(0, 30)
  const read = (card: HTMLElement, selector: string, limit: number): string => {
    return (card.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
  }
  return cards.map((card, cardIndex) => ({
    cardIndex,
    name: read(card, '.nest-resume-personal-name', 120),
    skills: read(card, '.nest-resume-personal-skills', 1200),
    summary: read(card, '.resume-description', 1600),
  })).filter(card => card.name !== '' || card.skills !== '' || card.summary !== '')
}

export function parseCandidatePreviews(value: unknown): CandidatePreview[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Invalid candidate preview result')
  return value.map(item => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid candidate preview item')
    const card = item as Record<string, unknown>
    if (!Number.isSafeInteger(card.cardIndex) || (card.cardIndex as number) < 0
      || typeof card.name !== 'string' || card.name.length > 120
      || typeof card.skills !== 'string' || card.skills.length > 1200
      || typeof card.summary !== 'string' || card.summary.length > 1600) {
      throw new Error('Invalid candidate preview fields')
    }
    return { cardIndex: card.cardIndex as number, name: card.name, skills: card.skills, summary: card.summary }
  })
}

/** Read only the one visible Liepin resume modal; never click or choose a candidate. */
export function extractOpenLiepinResume(doc: Document): OpenResume | null {
  const modals = Array.from(doc.querySelectorAll<HTMLElement>('.ant-lpt-modal')).filter(modal => {
    if (modal.getAttribute('aria-hidden') === 'true' || modal.hasAttribute('hidden')) return false
    const view = doc.defaultView
    const style = view?.getComputedStyle?.(modal)
    return style?.display !== 'none' && style?.visibility !== 'hidden'
  })
  if (modals.length !== 1) return null
  const modal = modals[0]
  const name = (modal.querySelector('.nest-resume-personal-name')?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)
  const text = (modal.innerText || modal.textContent || '').replace(/\r/gu, '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim().slice(0, 20_000)
  if (text.length < 20) return null
  return { name, text }
}

export function parseOpenResume(value: unknown): OpenResume {
  if (typeof value !== 'object' || value === null) throw new Error('No open resume detail found')
  const resume = value as Record<string, unknown>
  if (typeof resume.name !== 'string' || resume.name.length > 120
    || typeof resume.text !== 'string' || resume.text.length < 20 || resume.text.length > 20_000) {
    throw new Error('Invalid open resume result')
  }
  return { name: resume.name, text: resume.text }
}
