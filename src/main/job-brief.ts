import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface JobBrief {
  role: string
  requirements: string
  criteria: string[]
}

export interface JobRecord extends JobBrief {
  id: string
  updatedAt: string
}

export interface JobList {
  activeId: string | null
  jobs: JobRecord[]
}

interface JobsFile extends JobList { version: 1 }

export function jobBriefDigest(brief: JobBrief): string {
  return createHash('sha256').update(JSON.stringify([brief.role, brief.requirements, brief.criteria])).digest('hex')
}

export function parseJobBrief(value: unknown): JobBrief {
  if (typeof value !== 'object' || value === null) throw new Error('岗位条件格式无效')
  const brief = value as Record<string, unknown>
  if (typeof brief.role !== 'string' || typeof brief.requirements !== 'string') throw new Error('岗位条件格式无效')
  const role = brief.role.trim()
  const requirements = brief.requirements.trim()
  if (!role || role.length > 120 || !requirements || requirements.length > 4000) {
    throw new Error('岗位名称应为 1–120 字，岗位条件应为 1–4000 字')
  }
  const rawCriteria: unknown = brief.criteria === undefined
    ? [requirements.length <= 200 ? requirements : '岗位核心要求（详见岗位条件）']
    : brief.criteria
  if (!Array.isArray(rawCriteria) || rawCriteria.length < 1 || rawCriteria.length > 12) throw new Error('技能条件应有 1–12 项')
  const criteria = rawCriteria.map(value => {
    if (typeof value !== 'string') throw new Error('技能条件格式无效')
    const criterion = value.trim()
    if (!criterion || criterion.length > 200) throw new Error('每项技能条件应为 1–200 字')
    return criterion
  })
  if (new Set(criteria).size !== criteria.length) throw new Error('技能条件不能重复')
  return { role, requirements, criteria }
}

function parseJobsFile(value: unknown): JobsFile {
  if (typeof value !== 'object' || value === null) throw new Error('岗位列表格式无效')
  const file = value as Record<string, unknown>
  if (file.version !== 1 || !Array.isArray(file.jobs) || file.jobs.length > 100
    || (file.activeId !== null && typeof file.activeId !== 'string')) throw new Error('岗位列表格式无效')
  const jobs = file.jobs.map(value => {
    if (typeof value !== 'object' || value === null) throw new Error('岗位记录格式无效')
    const record = value as Record<string, unknown>
    if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.id)
      || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new Error('岗位记录格式无效')
    }
    return { id: record.id, updatedAt: record.updatedAt, ...parseJobBrief(record) }
  })
  if (new Set(jobs.map(job => job.id)).size !== jobs.length
    || (file.activeId !== null && !jobs.some(job => job.id === file.activeId))) throw new Error('岗位列表格式无效')
  return { version: 1, activeId: file.activeId, jobs }
}

/** Local role configuration. Candidate resumes are never written here. */
export class JobBriefStore {
  private readonly path: string
  private readonly legacyPath: string

  constructor(userData: string) {
    this.path = join(userData, 'agenthr-jobs.json')
    this.legacyPath = join(userData, 'agenthr-job-brief.json')
  }

  private read(): JobsFile {
    try { return parseJobsFile(JSON.parse(readFileSync(this.path, 'utf8')) as unknown) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let legacy: JobBrief
    try { legacy = parseJobBrief(JSON.parse(readFileSync(this.legacyPath, 'utf8')) as unknown) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, activeId: null, jobs: [] }
      throw error
    }
    const record = { ...legacy, id: randomUUID(), updatedAt: new Date().toISOString() }
    const migrated: JobsFile = { version: 1, activeId: record.id, jobs: [record] }
    this.write(migrated)
    return migrated
  }

  private write(file: JobsFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(file, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  list(): JobList {
    const { activeId, jobs } = this.read()
    return { activeId, jobs }
  }

  load(): JobBrief | null {
    const { activeId, jobs } = this.read()
    const record = jobs.find(job => job.id === activeId)
    return record ? { role: record.role, requirements: record.requirements, criteria: record.criteria } : null
  }

  save(value: unknown): JobRecord {
    const brief = parseJobBrief(value)
    const file = this.read()
    if (!file.activeId) return this.create(brief)
    const index = file.jobs.findIndex(job => job.id === file.activeId)
    if (index < 0) throw new Error('当前岗位不存在')
    const record = { ...file.jobs[index], ...brief, updatedAt: new Date().toISOString() }
    file.jobs[index] = record
    this.write(file)
    return record
  }

  create(value: unknown): JobRecord {
    const brief = parseJobBrief(value)
    const file = this.read()
    if (file.jobs.length >= 100) throw new Error('岗位数量已达到上限')
    const record = { ...brief, id: randomUUID(), updatedAt: new Date().toISOString() }
    file.jobs.push(record)
    file.activeId = record.id
    this.write(file)
    return record
  }

  activate(id: unknown): JobRecord {
    if (typeof id !== 'string') throw new Error('岗位 ID 无效')
    const file = this.read()
    const record = file.jobs.find(job => job.id === id)
    if (!record) throw new Error('岗位不存在')
    file.activeId = record.id
    this.write(file)
    return record
  }

  clearActive(): void {
    const file = this.read()
    file.activeId = null
    this.write(file)
  }
}
