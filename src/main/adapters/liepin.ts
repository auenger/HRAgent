/** One card on the currently loaded page. The index is ephemeral and must never identify a message recipient. */
export interface CandidatePreview {
  cardIndex: number
  name: string
  skills: string
  summary: string
  fingerprint?: string
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
  )).filter(card => {
    for (let node: HTMLElement | null = card; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }).slice(0, 30)
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

/** Read the visible Liepin resume panel on search or recommendation pages; never click or choose a candidate. */
export function extractOpenLiepinResume(doc: Document): OpenResume | null {
  const visible = (element: HTMLElement): boolean => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = doc.defaultView?.getComputedStyle?.(node)
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
        || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const selector = [
    '.ant-lpt-modal', '.ant-lpt-drawer-content', '.ant-drawer-content', '[role="dialog"]',
    '[class*="resume-detail"]', '[class*="resumeDetail"]', '[class*="resume-preview"]', '[class*="resumePreview"]',
  ].join(', ')
  const panels = Array.from(new Set<HTMLElement>(Array.from(doc.querySelectorAll<HTMLElement>(selector)))).filter(panel => {
    if (!visible(panel)) return false
    const text = (panel.innerText || panel.textContent || '').replace(/\s+/gu, ' ').trim()
    const evidenceMarkers = text.match(/工作经历|工作经验|项目经历|教育经历|求职意向|个人优势|专业技能|技能标签/gu)?.length ?? 0
    return panel.matches('.ant-lpt-modal') ? text.length >= 20 : text.length >= 80 && evidenceMarkers >= 2
  })
  if (panels.length === 0) return null
  // Several selectors can describe nested parts of the same drawer. The largest visible
  // evidence-bearing panel is the complete resume; two disjoint panels remain ambiguous.
  const ordered = panels.sort((left, right) => (right.innerText || right.textContent || '').length - (left.innerText || left.textContent || '').length)
  const panel = ordered[0]
  if (ordered.slice(1).some(candidate => !panel.contains(candidate) && !candidate.contains(panel))) return null
  const rawText = (panel.innerText || panel.textContent || '').replace(/\r/gu, '')
  let name = (panel.querySelector('.nest-resume-personal-name, .resume-name, [class*="resume-name"], [class*="user-name"], [class*="userName"], [class*="candidate-name"], [class*="candidateName"]')?.textContent ?? '')
    .replace(/\s+/gu, ' ').trim().slice(0, 120)
  if (!name) {
    const lines = rawText.split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean)
    const marker = lines.findIndex(line => /(?:\d+天内活跃|刚刚活跃|今日活跃|本周活跃|更新简历时间)/u.test(line))
    if (marker > 0) {
      const excluded = /^(?:中文|EN|快速定位[:：]?|查看大图|展开|收起|求职意向|工作经历|教育经历|项目经历|附件简历)$/iu
      name = lines.slice(Math.max(0, marker - 10), marker).reverse().find(line =>
        line.length <= 40 && !excluded.test(line) && !/^\(?\d+\)?$/u.test(line) && !/[：:]$/u.test(line),
      )?.slice(0, 120) ?? ''
    }
  }
  const text = rawText.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim().slice(0, 20_000)
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
