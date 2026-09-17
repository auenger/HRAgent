import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CandidatePreview, OpenResume } from './adapters/liepin.js'
import type { Platform } from './platforms.js'

export type CandidateStage = 'lead' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected'
export type TaskType = 'search' | 'analyze' | 'confirm' | 'follow_up'
export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type TaskEntryKind = 'analysis' | 'browser_result' | 'note'

export interface CandidateRecord {
  id: string
  displayName: string
  currentCompany: string
  currentTitle: string
  location: string
  expectedSalary: string
  expectedPosition: string
  stage: CandidateStage
  tags: string[]
  notes: string
  sourcePlatforms: Platform[]
  sourceCount: number
  jobIds: string[]
  createdAt: string
  updatedAt: string
}

export interface RecruitmentTask {
  id: string
  jobId: string | null
  type: TaskType
  status: TaskStatus
  platform: Platform | null
  profileId: string | null
  progress: number
  currentCandidateId: string | null
  title: string
  description: string
  resultSummary: string
  lastBrowserUrl: string | null
  runCount: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskEntry {
  id: string
  taskId: string
  kind: TaskEntryKind
  title: string
  content: string
  sourceUrl: string | null
  createdAt: string
}

export interface TaskFile { path: string; kind: 'input' | 'output'; createdAt: string }
export interface RecruitmentTaskDetail { task: RecruitmentTask; entries: TaskEntry[]; files: TaskFile[] }

export interface RecruitmentEvent {
  id: string
  type: string
  entityType: 'job' | 'candidate' | 'application' | 'task' | 'assessment'
  entityId: string
  summary: string
  createdAt: string
}

export interface PlatformValidationRecord {
  id: string
  platform: Platform
  check: 'candidate_list' | 'resume_detail'
  status: 'passed' | 'failed'
  summary: string
  runId: string
  createdAt: string
}

export interface GreetingRecord {
  id: string
  assessmentId: string
  jobId: string
  platform: 'boss'
  candidateName: string
  sourceDigest: string
  result: 'greeted' | 'already_contacted'
  createdAt: string
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/u.test(value)) throw new Error(`${label} 无效`)
}

function nextTimestamp(...previous: string[]): string {
  const latest = Math.max(0, ...previous.map(value => Date.parse(value)).filter(Number.isFinite))
  return new Date(Math.max(Date.now(), latest + 1)).toISOString()
}

/** Owns durable recruiting objects. Platform sources never merge across candidates by name. */
export class RecruitmentStore {
  private readonly db: DatabaseSync

  constructor(userData: string) {
    const path = join(userData, 'agenthr-recruitment.sqlite')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, current_company TEXT NOT NULL DEFAULT '',
        current_title TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        expected_salary TEXT NOT NULL DEFAULT '', expected_position TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL, tags_json TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate_sources (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, platform_candidate_id TEXT, profile_id TEXT NOT NULL,
        source_url TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, content_digest TEXT NOT NULL,
        identity_kind TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applications (
        candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE, job_id TEXT NOT NULL,
        stage TEXT NOT NULL, assessment_id TEXT, owner TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '',
        next_action_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS recruitment_tasks (
        id TEXT PRIMARY KEY, job_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, platform TEXT,
        profile_id TEXT, progress INTEGER NOT NULL, current_candidate_id TEXT,
        title TEXT NOT NULL, error_code TEXT, error_message TEXT, started_at TEXT, finished_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', result_summary TEXT NOT NULL DEFAULT '',
        last_browser_url TEXT, run_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS recruitment_task_entries (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES recruitment_tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source_url TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recruitment_task_files (
        task_id TEXT NOT NULL REFERENCES recruitment_tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, path, kind)
      );
      CREATE TABLE IF NOT EXISTS recruitment_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_validations (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, check_type TEXT NOT NULL, status TEXT NOT NULL,
        summary TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate_greetings (
        id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL,
        platform TEXT NOT NULL, candidate_name TEXT NOT NULL, source_digest TEXT NOT NULL,
        result TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(job_id, platform, source_digest)
      );
      CREATE INDEX IF NOT EXISTS candidate_sources_candidate ON candidate_sources(candidate_id);
      CREATE INDEX IF NOT EXISTS applications_job ON applications(job_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_updated ON recruitment_tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_entries_created ON recruitment_task_entries(task_id, created_at);
      CREATE INDEX IF NOT EXISTS events_created ON recruitment_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS platform_validations_created ON platform_validations(created_at DESC);
      CREATE INDEX IF NOT EXISTS candidate_greetings_created ON candidate_greetings(created_at DESC);
    `)
    const candidateColumns = this.db.prepare('PRAGMA table_info(candidates)').all()
    if (!candidateColumns.some(column => column.name === 'notes')) this.db.exec("ALTER TABLE candidates ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    const taskColumns = this.db.prepare('PRAGMA table_info(recruitment_tasks)').all()
    if (!taskColumns.some(column => column.name === 'description')) this.db.exec("ALTER TABLE recruitment_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''")
    if (!taskColumns.some(column => column.name === 'result_summary')) this.db.exec("ALTER TABLE recruitment_tasks ADD COLUMN result_summary TEXT NOT NULL DEFAULT ''")
    if (!taskColumns.some(column => column.name === 'last_browser_url')) this.db.exec('ALTER TABLE recruitment_tasks ADD COLUMN last_browser_url TEXT')
    if (!taskColumns.some(column => column.name === 'run_count')) this.db.exec('ALTER TABLE recruitment_tasks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0')
    this.db.exec("UPDATE recruitment_tasks SET description = title WHERE description = ''")
  }

  private event(type: string, entityType: RecruitmentEvent['entityType'], entityId: string, summary: string, now: string): RecruitmentEvent {
    const id = randomUUID(), safeSummary = boundedText(summary, 500)
    this.db.prepare('INSERT INTO recruitment_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, type, entityType, entityId, safeSummary, now)
    return { id, type, entityType, entityId, summary: safeSummary, createdAt: now }
  }

  recordEvent(type: string, entityType: RecruitmentEvent['entityType'], entityId: string, summary: string): RecruitmentEvent {
    const safeType = boundedText(type, 120), safeId = boundedText(entityId, 200), safeSummary = boundedText(summary, 500)
    if (!safeType || !safeId || !safeSummary) throw new Error('审计事件格式无效')
    const now = new Date().toISOString()
    return this.event(safeType, entityType, safeId, safeSummary, now)
  }

  captureVisible(previews: CandidatePreview[], platform: Platform, sourceUrl: string, jobId: string | null): CandidateRecord[] {
    if (platform !== 'boss' && platform !== 'liepin') throw new Error('候选人来源平台无效')
    if (!Array.isArray(previews) || previews.length > 30) throw new Error('候选人线索数量无效')
    if (jobId !== null) assertUuid(jobId, '岗位 ID')
    const now = new Date().toISOString()
    const ids: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const preview of previews) {
        const displayName = boundedText(preview.name, 120)
        if (!displayName) continue
        const fingerprint = typeof preview.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(preview.fingerprint)
          ? preview.fingerprint : createHash('sha256').update(JSON.stringify(preview)).digest('hex')
        const sourceKey = createHash('sha256').update(JSON.stringify([platform, sourceUrl, fingerprint])).digest('hex')
        const contentDigest = createHash('sha256').update(JSON.stringify([displayName, preview.skills, preview.summary])).digest('hex')
        const existing = this.db.prepare('SELECT candidate_id FROM candidate_sources WHERE source_key = ?').get(sourceKey)
        let candidateId = existing ? String(existing.candidate_id) : randomUUID()
        if (existing) {
          this.db.prepare('UPDATE candidates SET display_name = ?, current_title = ?, updated_at = ? WHERE id = ?')
            .run(displayName, boundedText(preview.skills || preview.summary, 300), now, candidateId)
          this.db.prepare('UPDATE candidate_sources SET content_digest = ?, last_seen_at = ? WHERE source_key = ?').run(contentDigest, now, sourceKey)
        } else {
          this.db.prepare(`INSERT INTO candidates
            (id, display_name, current_company, current_title, location, expected_salary, expected_position, stage, tags_json, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidateId, displayName, '', boundedText(preview.skills || preview.summary, 300), '', '', '', 'lead', '[]', '', now, now)
          this.db.prepare('INSERT INTO candidate_sources VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), candidateId, platform, 'primary', boundedText(sourceUrl, 2000), sourceKey, contentDigest, 'ephemeral_card', now)
          this.event('candidate.captured', 'candidate', candidateId, `从${platform === 'boss' ? 'BOSS 直聘' : '猎聘'}保存候选人线索：${displayName}`, now)
        }
        if (jobId) {
          const inserted = this.db.prepare(`INSERT OR IGNORE INTO applications
            (candidate_id, job_id, stage, assessment_id, owner, next_action, next_action_at, created_at, updated_at)
            VALUES (?, ?, 'lead', NULL, '', '', NULL, ?, ?)`).run(candidateId, jobId, now, now)
          if (inserted.changes > 0) this.event('application.linked', 'application', `${candidateId}:${jobId}`, `候选人已关联当前岗位`, now)
        }
        ids.push(candidateId)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return ids.map(id => this.getCandidate(id))
  }

  captureResume(resume: OpenResume, platform: Platform, sourceUrl: string, jobId: string | null, assessmentId?: string): CandidateRecord {
    const displayName = boundedText(resume.name, 120)
    if (!displayName) throw new Error('候选人姓名为空')
    if (jobId !== null) assertUuid(jobId, '岗位 ID')
    const digest = createHash('sha256').update(JSON.stringify([resume.name, resume.text])).digest('hex')
    const sourceKey = createHash('sha256').update(JSON.stringify([platform, 'resume', digest])).digest('hex')
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    let candidateId: string
    try {
      const existing = this.db.prepare('SELECT candidate_id FROM candidate_sources WHERE source_key = ?').get(sourceKey)
      candidateId = existing ? String(existing.candidate_id) : randomUUID()
      if (existing) {
        this.db.prepare('UPDATE candidates SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName, now, candidateId)
        this.db.prepare('UPDATE candidate_sources SET source_url = ?, last_seen_at = ? WHERE source_key = ?').run(boundedText(sourceUrl, 2000), now, sourceKey)
      } else {
        this.db.prepare(`INSERT INTO candidates
          (id, display_name, current_company, current_title, location, expected_salary, expected_position, stage, tags_json, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidateId, displayName, '', '', '', '', '', 'screening', '[]', '', now, now)
        this.db.prepare('INSERT INTO candidate_sources VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(randomUUID(), candidateId, platform, 'primary', boundedText(sourceUrl, 2000), sourceKey, digest, 'resume_digest', now)
        this.event('candidate.resume_captured', 'candidate', candidateId, `保存候选人简历来源：${displayName}`, now)
      }
      if (jobId) {
        this.db.prepare(`INSERT INTO applications (candidate_id, job_id, stage, assessment_id, owner, next_action, next_action_at, created_at, updated_at)
          VALUES (?, ?, 'screening', ?, '', '', NULL, ?, ?)
          ON CONFLICT(candidate_id, job_id) DO UPDATE SET stage = 'screening', assessment_id = COALESCE(excluded.assessment_id, applications.assessment_id), updated_at = excluded.updated_at`)
          .run(candidateId, jobId, assessmentId ?? null, now, now)
      }
      if (assessmentId) this.event('assessment.saved', 'assessment', assessmentId, `保存${displayName}的岗位分析草稿`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getCandidate(candidateId!)
  }

  private decodeCandidate(row: Record<string, unknown>): CandidateRecord {
    const id = String(row.id)
    const sources = this.db.prepare('SELECT DISTINCT platform FROM candidate_sources WHERE candidate_id = ? ORDER BY platform').all(id)
    const jobs = this.db.prepare('SELECT job_id FROM applications WHERE candidate_id = ? ORDER BY created_at').all(id)
    return { id, displayName: String(row.display_name), currentCompany: String(row.current_company), currentTitle: String(row.current_title),
      location: String(row.location), expectedSalary: String(row.expected_salary), expectedPosition: String(row.expected_position),
      stage: (row.application_stage ?? row.stage) as CandidateStage, tags: JSON.parse(String(row.tags_json)) as string[],
      notes: String(row.notes),
      sourcePlatforms: sources.map(item => item.platform as Platform), sourceCount: Number(row.source_count),
      jobIds: jobs.map(item => String(item.job_id)), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  getCandidate(id: string, jobId?: string): CandidateRecord {
    const row = jobId
      ? this.db.prepare(`SELECT c.*, (SELECT stage FROM applications WHERE candidate_id = c.id AND job_id = ?) AS application_stage,
          COUNT(s.id) AS source_count FROM candidates c LEFT JOIN candidate_sources s ON s.candidate_id = c.id WHERE c.id = ? GROUP BY c.id`).get(jobId, id)
      : this.db.prepare(`SELECT c.*, COUNT(s.id) AS source_count FROM candidates c
          LEFT JOIN candidate_sources s ON s.candidate_id = c.id WHERE c.id = ? GROUP BY c.id`).get(id)
    if (!row) throw new Error('候选人不存在')
    return this.decodeCandidate(row)
  }

  listCandidates(limit = 100, jobId?: string): CandidateRecord[] {
    const bounded = Math.max(1, Math.min(100, limit))
    const rows = jobId
      ? this.db.prepare(`SELECT c.*, a.stage AS application_stage, COUNT(s.id) AS source_count FROM candidates c JOIN applications a ON a.candidate_id = c.id
          LEFT JOIN candidate_sources s ON s.candidate_id = c.id WHERE a.job_id = ? GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?`).all(jobId, bounded)
      : this.db.prepare(`SELECT c.*, COUNT(s.id) AS source_count FROM candidates c LEFT JOIN candidate_sources s ON s.candidate_id = c.id
          GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?`).all(bounded)
    return rows.map(row => this.decodeCandidate(row))
  }

  setApplicationStage(candidateId: string, jobId: string, stage: CandidateStage, expectedUpdatedAt?: string): CandidateRecord {
    assertUuid(candidateId, '候选人 ID')
    assertUuid(jobId, '岗位 ID')
    const stages: CandidateStage[] = ['lead', 'screening', 'interview', 'offer', 'hired', 'rejected']
    if (!stages.includes(stage)) throw new Error('候选人阶段无效')
    const application = this.db.prepare('SELECT stage FROM applications WHERE candidate_id = ? AND job_id = ?').get(candidateId, jobId)
    if (!application) throw new Error('候选人与当前岗位没有关联')
    const candidate = this.getCandidate(candidateId)
    if (expectedUpdatedAt !== undefined && candidate.updatedAt !== expectedUpdatedAt) throw new Error('候选人资料已变化，请刷新后重试')
    if (String(application.stage) === stage) return this.getCandidate(candidateId, jobId)
    const now = nextTimestamp(candidate.updatedAt)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE applications SET stage = ?, updated_at = ? WHERE candidate_id = ? AND job_id = ?').run(stage, now, candidateId, jobId)
      this.db.prepare('UPDATE candidates SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now, candidateId)
      this.event('application.stage_changed', 'application', `${candidateId}:${jobId}`, `候选人阶段：${String(application.stage)} -> ${stage}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getCandidate(candidateId, jobId)
  }

  updateCandidate(id: string, expectedUpdatedAt: string, value: unknown): CandidateRecord {
    assertUuid(id, '候选人 ID')
    if (typeof value !== 'object' || value === null) throw new Error('候选人资料格式无效')
    const current = this.getCandidate(id)
    if (current.updatedAt !== expectedUpdatedAt) throw new Error('候选人资料已变化，请刷新后重试')
    const input = value as Record<string, unknown>
    const displayName = boundedText(input.displayName ?? current.displayName, 120)
    if (!displayName) throw new Error('候选人姓名不能为空')
    const tags = input.tags === undefined ? current.tags : Array.isArray(input.tags)
      ? input.tags.map(tag => boundedText(tag, 40)).filter(Boolean).slice(0, 20) : (() => { throw new Error('候选人标签格式无效') })()
    const uniqueTags = [...new Set(tags)]
    const next = {
      displayName,
      currentCompany: boundedText(input.currentCompany ?? current.currentCompany, 200),
      currentTitle: boundedText(input.currentTitle ?? current.currentTitle, 200),
      location: boundedText(input.location ?? current.location, 120),
      expectedSalary: boundedText(input.expectedSalary ?? current.expectedSalary, 120),
      expectedPosition: boundedText(input.expectedPosition ?? current.expectedPosition, 200),
      notes: boundedText(input.notes ?? current.notes, 4000),
    }
    const now = nextTimestamp(current.updatedAt)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE candidates SET display_name = ?, current_company = ?, current_title = ?, location = ?,
        expected_salary = ?, expected_position = ?, tags_json = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .run(next.displayName, next.currentCompany, next.currentTitle, next.location, next.expectedSalary, next.expectedPosition, JSON.stringify(uniqueTags), next.notes, now, id)
      this.event('candidate.updated', 'candidate', id, `更新候选人资料：${next.displayName}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getCandidate(id)
  }

  mergeCandidates(primaryId: string, duplicateId: string, expectedPrimaryUpdatedAt: string, expectedDuplicateUpdatedAt: string): CandidateRecord {
    assertUuid(primaryId, '保留候选人 ID')
    assertUuid(duplicateId, '重复候选人 ID')
    if (primaryId === duplicateId) throw new Error('不能合并同一候选人')
    const primary = this.getCandidate(primaryId), duplicate = this.getCandidate(duplicateId)
    if (primary.updatedAt !== expectedPrimaryUpdatedAt || duplicate.updatedAt !== expectedDuplicateUpdatedAt) throw new Error('候选人资料已变化，请刷新后重试')
    const now = nextTimestamp(primary.updatedAt, duplicate.updatedAt)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE candidate_sources SET candidate_id = ? WHERE candidate_id = ?').run(primaryId, duplicateId)
      this.db.prepare(`INSERT OR IGNORE INTO applications
        (candidate_id, job_id, stage, assessment_id, owner, next_action, next_action_at, created_at, updated_at)
        SELECT ?, job_id, stage, assessment_id, owner, next_action, next_action_at, created_at, ? FROM applications WHERE candidate_id = ?`)
        .run(primaryId, now, duplicateId)
      this.db.prepare('DELETE FROM applications WHERE candidate_id = ?').run(duplicateId)
      this.db.prepare('UPDATE recruitment_tasks SET current_candidate_id = ?, updated_at = ? WHERE current_candidate_id = ?').run(primaryId, now, duplicateId)
      const tags = [...new Set([...primary.tags, ...duplicate.tags])]
      const notes = [primary.notes, duplicate.notes].filter(Boolean).join('\n\n').slice(0, 4000)
      this.db.prepare('UPDATE candidates SET tags_json = ?, notes = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(tags), notes, now, primaryId)
      this.db.prepare('DELETE FROM candidates WHERE id = ?').run(duplicateId)
      this.event('candidate.merged', 'candidate', primaryId, `合并重复候选人：${duplicate.displayName} -> ${primary.displayName}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getCandidate(primaryId)
  }

  createTask(value: unknown): RecruitmentTask {
    if (typeof value !== 'object' || value === null) throw new Error('任务格式无效')
    const input = value as Record<string, unknown>
    const types: TaskType[] = ['search', 'analyze', 'confirm', 'follow_up']
    if (!types.includes(input.type as TaskType)) throw new Error('任务类型无效')
    if (input.jobId !== null && input.jobId !== undefined) assertUuid(input.jobId, '岗位 ID')
    if (input.platform !== null && input.platform !== undefined && input.platform !== 'boss' && input.platform !== 'liepin') throw new Error('任务平台无效')
    const jobId = input.jobId === undefined || input.jobId === null ? null : String(input.jobId)
    const type = input.type as TaskType
    const platform = input.platform === 'boss' || input.platform === 'liepin' ? input.platform : null
    const title = boundedText(input.title, 200)
    if (!title) throw new Error('任务标题不能为空')
    const description = boundedText(input.description, 8000)
    if (!description) throw new Error('任务输入不能为空')
    const workspacePaths = Array.isArray(input.workspacePaths)
      ? [...new Set(input.workspacePaths.map(path => boundedText(path, 500)).filter(Boolean))].slice(0, 20) : []
    const now = new Date().toISOString(), id = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO recruitment_tasks
        (id, job_id, type, status, platform, profile_id, progress, current_candidate_id, title,
         error_code, error_message, started_at, finished_at, created_at, updated_at, description,
         result_summary, last_browser_url, run_count)
        VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, '', NULL, 0)`)
        .run(id, jobId, type, platform, boundedText(input.profileId, 120) || null, title, now, now, description)
      for (const path of workspacePaths) {
        this.db.prepare("INSERT INTO recruitment_task_files VALUES (?, ?, 'input', ?)").run(id, path, now)
      }
      this.event('task.created', 'task', id, `创建任务：${title}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getTask(id)
  }

  getTask(id: string): RecruitmentTask {
    const row = this.db.prepare('SELECT * FROM recruitment_tasks WHERE id = ?').get(id)
    if (!row) throw new Error('招聘任务不存在')
    return { id: String(row.id), jobId: row.job_id === null ? null : String(row.job_id), type: row.type as TaskType,
      status: row.status as TaskStatus, platform: row.platform as Platform | null, profileId: row.profile_id === null ? null : String(row.profile_id),
      progress: Number(row.progress), currentCandidateId: row.current_candidate_id === null ? null : String(row.current_candidate_id),
      title: String(row.title), description: String(row.description ?? ''), resultSummary: String(row.result_summary ?? ''),
      lastBrowserUrl: row.last_browser_url === null ? null : String(row.last_browser_url), runCount: Number(row.run_count ?? 0),
      errorCode: row.error_code === null ? null : String(row.error_code), errorMessage: row.error_message === null ? null : String(row.error_message),
      startedAt: row.started_at === null ? null : String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  listTasks(limit = 100, jobId?: string): RecruitmentTask[] {
    const bounded = Math.max(1, Math.min(100, limit))
    const rows = jobId ? this.db.prepare('SELECT id FROM recruitment_tasks WHERE job_id = ? ORDER BY updated_at DESC LIMIT ?').all(jobId, bounded)
      : this.db.prepare('SELECT id FROM recruitment_tasks ORDER BY updated_at DESC LIMIT ?').all(bounded)
    return rows.map(row => this.getTask(String(row.id)))
  }

  getTaskDetail(id: string): RecruitmentTaskDetail {
    const task = this.getTask(id)
    const entries = this.db.prepare('SELECT * FROM recruitment_task_entries WHERE task_id = ? ORDER BY created_at ASC').all(id).map(row => ({
      id: String(row.id), taskId: String(row.task_id), kind: row.kind as TaskEntryKind,
      title: String(row.title), content: String(row.content), sourceUrl: row.source_url === null ? null : String(row.source_url), createdAt: String(row.created_at),
    }))
    const files = this.db.prepare('SELECT path, kind, created_at FROM recruitment_task_files WHERE task_id = ? ORDER BY created_at ASC').all(id).map(row => ({
      path: String(row.path), kind: row.kind as TaskFile['kind'], createdAt: String(row.created_at),
    }))
    return { task, entries, files }
  }

  beginTaskRun(id: string): RecruitmentTask {
    const task = this.getTask(id), now = nextTimestamp(task.updatedAt)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE recruitment_tasks SET status = 'running', started_at = COALESCE(started_at, ?),
        finished_at = NULL, error_code = NULL, error_message = NULL, run_count = run_count + 1, updated_at = ? WHERE id = ?`)
        .run(now, now, id)
      this.event('task.run_started', 'task', id, `开始执行任务：${task.title}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getTask(id)
  }

  appendTaskEntry(id: string, value: unknown, sourceUrl?: string | null): RecruitmentTaskDetail {
    if (typeof value !== 'object' || value === null) throw new Error('任务结果格式无效')
    const input = value as Record<string, unknown>
    const kinds: TaskEntryKind[] = ['analysis', 'browser_result', 'note']
    if (!kinds.includes(input.kind as TaskEntryKind)) throw new Error('任务结果类型无效')
    const title = boundedText(input.title, 200), content = boundedText(input.content, 20_000)
    if (!title || !content) throw new Error('任务结果标题和内容不能为空')
    const task = this.getTask(id), now = nextTimestamp(task.updatedAt), kind = input.kind as TaskEntryKind
    const safeSourceUrl = kind === 'browser_result' ? boundedText(sourceUrl, 1000) || null : null
    const outputPaths = Array.isArray(input.workspacePaths)
      ? [...new Set(input.workspacePaths.map(path => boundedText(path, 500)).filter(Boolean))].slice(0, 20) : []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO recruitment_task_entries VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), id, kind, title, content, safeSourceUrl, now)
      for (const path of outputPaths) this.db.prepare("INSERT OR IGNORE INTO recruitment_task_files VALUES (?, ?, 'output', ?)").run(id, path, now)
      const status = task.status === 'queued' || task.status === 'paused' || task.status === 'failed' ? 'running' : task.status
      const startedAt = task.startedAt ?? now
      this.db.prepare(`UPDATE recruitment_tasks SET status = ?, started_at = ?, result_summary = ?,
        last_browser_url = COALESCE(?, last_browser_url), run_count = CASE WHEN run_count = 0 THEN 1 ELSE run_count END, updated_at = ?,
        error_code = NULL, error_message = NULL WHERE id = ?`)
        .run(status, startedAt, content.slice(0, 1000), safeSourceUrl, now, id)
      this.event('task.result_added', 'task', id, `写入任务结果：${title}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getTaskDetail(id)
  }

  setTaskStatus(id: string, status: TaskStatus, expectedUpdatedAt?: string, failure?: { code?: unknown; message?: unknown }): RecruitmentTask {
    const statuses: TaskStatus[] = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']
    if (!statuses.includes(status)) throw new Error('任务状态无效')
    const current = this.getTask(id), now = nextTimestamp(current.updatedAt)
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error('招聘任务已变化，请刷新后重试')
    if (current.status === status) return current
    const startedAt = status === 'running' ? current.startedAt ?? now : current.startedAt
    const finishedAt = status === 'completed' || status === 'failed' || status === 'cancelled' ? now : null
    const progress = status === 'completed' ? 100 : current.progress
    const errorCode = status === 'failed' ? boundedText(failure?.code, 80) || 'TASK_FAILED' : null
    const errorMessage = status === 'failed' ? boundedText(failure?.message, 500) || '任务执行失败，请检查当前页面后重试。' : null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE recruitment_tasks SET status = ?, progress = ?, started_at = ?, finished_at = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run(status, progress, startedAt, finishedAt, errorCode, errorMessage, now, id)
      this.event('task.status_changed', 'task', id, `任务状态：${current.status} -> ${status}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getTask(id)
  }

  listEvents(limit = 100): RecruitmentEvent[] {
    return this.db.prepare('SELECT * FROM recruitment_events ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))).map(row => ({
      id: String(row.id), type: String(row.type), entityType: row.entity_type as RecruitmentEvent['entityType'], entityId: String(row.entity_id), summary: String(row.summary), createdAt: String(row.created_at),
    }))
  }

  recordPlatformValidation(platform: Platform, check: PlatformValidationRecord['check'], status: PlatformValidationRecord['status'], summary: string, runId: string): PlatformValidationRecord {
    if ((platform !== 'boss' && platform !== 'liepin') || !['candidate_list', 'resume_detail'].includes(check)
      || !['passed', 'failed'].includes(status) || !/^[0-9a-f-]{36}$/u.test(runId)) throw new Error('平台验收记录格式无效')
    const record = { id: randomUUID(), platform, check, status, summary: boundedText(summary, 500), runId, createdAt: new Date().toISOString() }
    if (!record.summary) throw new Error('平台验收摘要不能为空')
    this.db.prepare('INSERT INTO platform_validations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.platform, record.check, record.status, record.summary, record.runId, record.createdAt)
    return record
  }

  listPlatformValidations(limit = 100): PlatformValidationRecord[] {
    return this.db.prepare('SELECT * FROM platform_validations ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))).map(row => ({
      id: String(row.id), platform: row.platform as Platform, check: row.check_type as PlatformValidationRecord['check'],
      status: row.status as PlatformValidationRecord['status'], summary: String(row.summary), runId: String(row.run_id), createdAt: String(row.created_at),
    }))
  }

  getGreetingForAssessment(assessmentId: string): GreetingRecord | null {
    const row = this.db.prepare('SELECT * FROM candidate_greetings WHERE assessment_id = ?').get(assessmentId)
    if (!row) return null
    return { id: String(row.id), assessmentId: String(row.assessment_id), jobId: String(row.job_id), platform: 'boss',
      candidateName: String(row.candidate_name), sourceDigest: String(row.source_digest), result: row.result as GreetingRecord['result'], createdAt: String(row.created_at) }
  }

  findGreeting(jobId: string, sourceDigest: string): GreetingRecord | null {
    const row = this.db.prepare('SELECT * FROM candidate_greetings WHERE job_id = ? AND platform = ? AND source_digest = ?')
      .get(jobId, 'boss', sourceDigest)
    if (!row) return null
    return { id: String(row.id), assessmentId: String(row.assessment_id), jobId: String(row.job_id), platform: 'boss',
      candidateName: String(row.candidate_name), sourceDigest: String(row.source_digest), result: row.result as GreetingRecord['result'], createdAt: String(row.created_at) }
  }

  countGreetedSince(jobId: string, since: string): number {
    assertUuid(jobId, '岗位 ID')
    if (!Number.isFinite(Date.parse(since))) throw new Error('打招呼统计时间无效')
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM candidate_greetings WHERE job_id = ? AND result = 'greeted' AND created_at >= ?")
      .get(jobId, since)
    return Number(row?.total ?? 0)
  }

  recordGreeting(value: { assessmentId: string; jobId: string; candidateName: string; sourceDigest: string; result: GreetingRecord['result'] }): GreetingRecord {
    assertUuid(value.assessmentId, '分析记录 ID')
    assertUuid(value.jobId, '岗位 ID')
    const candidateName = boundedText(value.candidateName, 120)
    if (!candidateName || !/^[a-f0-9]{64}$/u.test(value.sourceDigest)
      || (value.result !== 'greeted' && value.result !== 'already_contacted')) throw new Error('打招呼记录格式无效')
    const existing = this.getGreetingForAssessment(value.assessmentId)
    if (existing) return existing
    const duplicate = this.findGreeting(value.jobId, value.sourceDigest)
    if (duplicate) return duplicate
    const record: GreetingRecord = { id: randomUUID(), assessmentId: value.assessmentId, jobId: value.jobId, platform: 'boss',
      candidateName, sourceDigest: value.sourceDigest, result: value.result, createdAt: new Date().toISOString() }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO candidate_greetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.assessmentId, record.jobId, record.platform, record.candidateName, record.sourceDigest, record.result, record.createdAt)
      this.event(record.result === 'greeted' ? 'candidate.greeted' : 'candidate.already_contacted', 'assessment', record.assessmentId,
        record.result === 'greeted' ? `已在 BOSS 直聘向${record.candidateName}打招呼` : `${record.candidateName}在 BOSS 直聘已沟通，未重复打招呼`, record.createdAt)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return record
  }

  close(): void { this.db.close() }
}
