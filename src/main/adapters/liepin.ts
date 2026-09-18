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
  currentCompany: string
  currentTitle: string
  location: string
  expectedSalary: string
  expectedPosition: string
}

export type ResumeProfile = Omit<OpenResume, 'text'>

const ACTIVITY_OR_UI_TEXT = /^(?:今(?:天|日)活跃|在线|刚刚活跃|本周活跃|\d+天内活跃|更新简历时间.*|中文|EN|快速定位[:：]?|查看大图|展开|收起)$/iu

function cleanValue(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, limit) : ''
}

function credibleName(value: unknown): string {
  const name = cleanValue(value, 120)
  if (!name || ACTIVITY_OR_UI_TEXT.test(name) || /(?:活跃|在线|更新简历|求职意向|工作经历|教育经历|项目经历)/u.test(name)) return ''
  if (/^[\p{Script=Han}·•*＊]{2,12}$/u.test(name)) return name
  if (/^[\p{L}][\p{L} .'-]{1,39}$/u.test(name) && !/[：:]/u.test(name)) return name
  return ''
}

/** Parse bounded profile fields from a resume snapshot without retaining the full body. */
export function parseResumeProfile(text: string): ResumeProfile {
  const lines = text.replace(/\r/gu, '').split(/\n+/u).map(line => cleanValue(line, 500)).filter(Boolean)
  const joined = lines.join('\n')
  const labelled = (labels: string[], limit: number): string => {
    const alternatives = labels.join('|')
    const match = joined.match(new RegExp(`(?:^|\\n)(?:${alternatives})\\s*[:：]?\\s*([^\\n]{1,${limit}})`, 'iu'))
    return cleanValue(match?.[1], limit)
  }
  const start = lines.findIndex(line => /^工作经历$/u.test(line))
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start
    && /^(?:项目经历|教育经历|培训经历|自我评价|个人优势|语言能力|专业技能|技能标签|求职意向)$/u.test(line))
  const work = start < 0 ? [] : lines.slice(start + 1, end < 0 ? Math.min(lines.length, start + 16) : end)
  const dateIndex = work.findIndex(line => /(?:至今|现在|目前|\d{4}[./年-]\d{1,2}).*(?:\d{4}[./年-]\d{1,2}|至今|现在|目前)/u.test(line))
  const employment = (dateIndex >= 2 ? work.slice(dateIndex - 2, dateIndex)
    : dateIndex >= 0 ? work.slice(dateIndex + 1) : work).filter(line =>
    !/^(?:工作内容|工作描述|主要职责|职责描述)[:：]?/u.test(line) && line.length <= 200,
  )
  const intentionStart = lines.findIndex(line => /^求职意向$/u.test(line))
  const intentionEnd = intentionStart < 0 ? -1 : lines.findIndex((line, index) => index > intentionStart
    && /^(?:个人作品|工作经历|项目经历|教育经历|个人优势|专业技能)$/u.test(line))
  const intention = intentionStart < 0 ? [] : lines.slice(intentionStart + 1,
    intentionEnd < 0 ? Math.min(lines.length, intentionStart + 10) : intentionEnd)
  const experienceIndex = lines.findIndex(line => /^(?:工作\d+年|\d+年工作经验|\d+年经验)$/u.test(line))
  const headerLocation = experienceIndex > 0 && /^(?:[\p{Script=Han}A-Za-z]+)(?:-[\p{Script=Han}A-Za-z]+)?$/u.test(lines[experienceIndex - 1])
    ? cleanValue(lines[experienceIndex - 1], 120) : ''
  return {
    name: credibleName(labelled(['姓名'], 120)),
    currentCompany: labelled(['当前公司', '目前公司', '所在公司'], 200) || cleanValue(employment[0], 200),
    currentTitle: labelled(['当前职位', '目前职位', '职位名称', '岗位名称'], 200) || cleanValue(employment[1], 200),
    location: labelled(['现居地', '所在地', '当前城市', '所在城市', '居住地'], 120) || headerLocation,
    expectedSalary: labelled(['期望薪资', '期望月薪', '薪资期望'], 120)
      || cleanValue(intention.find(line => /(?:\d\s*[-–—]\s*\d+\s*[kK]|\d+\s*[kK]|薪|面议)/u.test(line)), 120),
    expectedPosition: labelled(['期望职位', '期望岗位', '意向职位', '意向岗位'], 200) || cleanValue(intention[0], 200),
  }
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
  const nameSelectors = ['.nest-resume-personal-name', '.resume-name', '[class~="resume-name"]', '[class~="user-name"]',
    '[class~="userName"]', '[class~="candidate-name"]', '[class~="candidateName"]', '[data-field="name"]', '[data-testid="candidate-name"]']
  const invalidName = /^(?:今(?:天|日)活跃|在线|刚刚活跃|本周活跃|\d+天内活跃|更新简历时间.*|中文|EN|快速定位[:：]?|查看大图|展开|收起)$/iu
  const normalizeName = (value: string): string => {
    const candidate = value.replace(/\s+/gu, ' ').trim().slice(0, 120)
    if (!candidate || invalidName.test(candidate) || /(?:活跃|在线|更新简历|求职意向|工作经历|教育经历|项目经历)/u.test(candidate)) return ''
    if (/^[\p{Script=Han}·•*＊]{2,12}$/u.test(candidate)) return candidate
    if (/^[\p{L}][\p{L} .'-]{1,39}$/u.test(candidate) && !/[：:]/u.test(candidate)) return candidate
    return ''
  }
  let name = ''
  for (const nameSelector of nameSelectors) {
    name = normalizeName(panel.querySelector(nameSelector)?.textContent ?? '')
    if (name) break
  }
  if (!name) {
    const lines = rawText.split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean)
    const marker = lines.findIndex(line => /(?:在线|\d+天内活跃|刚刚活跃|今(?:天|日)活跃|本周活跃|更新简历时间)/u.test(line))
    if (marker > 0) {
      const excluded = /^(?:中文|EN|快速定位[:：]?|查看大图|展开|收起|求职意向|工作经历|教育经历|项目经历|附件简历|今(?:天|日)活跃|在线|刚刚活跃|本周活跃|\d+天内活跃)$/iu
      name = lines.slice(Math.max(0, marker - 10), marker).reverse().find(line =>
        line.length <= 40 && !excluded.test(line) && !/^\(?\d+\)?$/u.test(line) && !/[：:]$/u.test(line) && normalizeName(line) !== '',
      )?.slice(0, 120) ?? ''
    }
  }
  const text = rawText.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim().slice(0, 20_000)
  if (text.length < 20) return null
  return { name, text, currentCompany: '', currentTitle: '', location: '', expectedSalary: '', expectedPosition: '' }
}

export function parseOpenResume(value: unknown): OpenResume {
  if (typeof value !== 'object' || value === null) throw new Error('No open resume detail found')
  const resume = value as Record<string, unknown>
  if (typeof resume.name !== 'string' || resume.name.length > 120
    || typeof resume.text !== 'string' || resume.text.length < 20 || resume.text.length > 20_000) {
    throw new Error('Invalid open resume result')
  }
  const parsed = parseResumeProfile(resume.text)
  const field = (key: keyof ResumeProfile, limit: number): string => cleanValue(resume[key], limit) || cleanValue(parsed[key], limit)
  const name = credibleName(resume.name) || parsed.name
  return { name, text: resume.text, currentCompany: field('currentCompany', 200), currentTitle: field('currentTitle', 200),
    location: field('location', 120), expectedSalary: field('expectedSalary', 120), expectedPosition: field('expectedPosition', 200) }
}
