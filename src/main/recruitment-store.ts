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
export type RecruitmentSkillStatus = 'draft' | 'enabled' | 'disabled' | 'needs_repair'
export type RecruitmentSkillExecutionMode = 'agent_guided' | 'deterministic'
export type RecruitmentSkillCategory = 'general' | 'boss' | 'liepin'

export interface RecruitmentSkillParameter {
  key: string
  label: string
  description: string
  type: 'text' | 'number' | 'boolean'
  required: boolean
  defaultValue: string | number | boolean
}

export interface RecruitmentSkillStep { id: string; title: string; description: string; verification: string }
export interface RecruitmentSkillDefinition {
  taskType: TaskType
  parameters: RecruitmentSkillParameter[]
  steps: RecruitmentSkillStep[]
  permissions: string[]
  successCriteria: string[]
  failureStrategy: string
}

export interface RecruitmentSkill {
  id: string
  key: string
  name: string
  description: string
  category: RecruitmentSkillCategory
  platform: Platform | null
  status: RecruitmentSkillStatus
  activeVersion: number
  executionMode: RecruitmentSkillExecutionMode
  riskLevel: 'read_only' | 'local_write' | 'external_action'
  definition: RecruitmentSkillDefinition
  runCount: number
  successCount: number
  sourceTaskCount: number
  consecutiveFailures: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RecruitmentSkillRun {
  id: string
  skillId: string
  version: number
  taskId: string
  status: 'running' | 'completed' | 'failed'
  parameters: Record<string, string | number | boolean>
  resultSummary: string
  startedAt: string
  finishedAt: string | null
}

export type RecruitmentSkillStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export interface RecruitmentSkillRunStep {
  id: string
  runId: string
  stepId: string
  stepIndex: number
  title: string
  status: RecruitmentSkillStepStatus
  evidence: string
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface SkillStepUpdateResult {
  run: RecruitmentSkillRun
  steps: RecruitmentSkillRunStep[]
  fallbackRequired: boolean
  fallbackPrompt: string | null
}

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
export interface RecruitmentTaskDetail {
  task: RecruitmentTask
  entries: TaskEntry[]
  files: TaskFile[]
  skillRun?: RecruitmentSkillRun
  skillSteps?: RecruitmentSkillRunStep[]
}

export interface RecruitmentEvent {
  id: string
  type: string
  entityType: 'job' | 'candidate' | 'application' | 'task' | 'assessment' | 'skill'
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

const BUILTIN_SKILLS: Array<Omit<RecruitmentSkill, 'id' | 'activeVersion' | 'runCount' | 'successCount' | 'sourceTaskCount' | 'consecutiveFailures' | 'lastRunAt' | 'createdAt' | 'updatedAt'>> = [
  {
    key: 'liepin-search-and-save', name: '猎聘搜索并保存候选人', category: 'liepin', platform: 'liepin', status: 'enabled', executionMode: 'agent_guided', riskLevel: 'local_write',
    description: '按当前岗位、关键词和城市搜索候选人，读取限定数量的简历并保存到人才库。',
    definition: {
      taskType: 'search',
      parameters: [
        { key: 'keyword', label: '搜索关键词', description: '用于猎聘人才搜索的岗位或技能关键词。', type: 'text', required: true, defaultValue: '' },
        { key: 'city', label: '目前城市', description: '筛选候选人的当前所在城市。', type: 'text', required: true, defaultValue: '' },
        { key: 'maxCandidates', label: '最多读取人数', description: '本次最多打开并分析的候选人数。', type: 'number', required: true, defaultValue: 10 },
        { key: 'minimumExperienceYears', label: '最低工作年限', description: '卡片明确不足该年限时跳过详情。', type: 'number', required: false, defaultValue: 0 },
      ],
      steps: [
        { id: 'check-context', title: '检查岗位与平台', description: '确认当前岗位存在、猎聘已登录并由 Agent 控制。', verification: '当前岗位和活跃平台均与技能要求一致。' },
        { id: 'search', title: '设置搜索条件', description: '进入搜索人才页，填写关键词并选择目前城市。', verification: '关键词输入值和城市条件标签与参数一致。' },
        { id: 'read', title: '读取候选人', description: '按上限逐个打开符合基础条件的候选人详情。', verification: '任一时刻恰好只有一份可见简历详情。' },
        { id: 'save', title: '保存人才资料', description: '提取姓名、公司、职位、所在地、期望职位和薪资并关联当前岗位。', verification: '人才库记录字段通过姓名与完整度校验。' },
      ],
      permissions: ['读取招聘网站页面', '读取可见简历详情', '写入本地人才库', '禁止联系候选人', '禁止下载附件'],
      successCriteria: ['搜索关键词和城市筛选已生效', '保存人数不超过参数上限', '姓名不得为活跃状态文案', '每条记录关联当前岗位和猎聘来源'],
      failureStrategy: '任一步骤的语义目标或结果校验失败时停止确定性动作，保留断点并交回 Agent 诊断。',
    },
  },
  {
    key: 'boss-recommend-and-save', name: 'BOSS 推荐页读取并保存候选人', category: 'boss', platform: 'boss', status: 'enabled', executionMode: 'agent_guided', riskLevel: 'local_write',
    description: '读取 BOSS 直聘当前推荐列表中的候选人线索，逐一核对详情并保存到当前岗位人才库。',
    definition: {
      taskType: 'search',
      parameters: [
        { key: 'maxCandidates', label: '最多读取人数', description: '本次最多打开并保存的候选人数。', type: 'number', required: true, defaultValue: 10 },
        { key: 'minimumExperienceYears', label: '最低工作年限', description: '卡片明确不足该年限时跳过详情。', type: 'number', required: false, defaultValue: 0 },
      ],
      steps: [
        { id: 'check-boss', title: '检查 BOSS 页面', description: '确认 BOSS 直聘已登录，当前推荐列表可见且由 Agent 控制。', verification: '活跃平台为 BOSS，列表存在可见候选人卡片。' },
        { id: 'collect-cards', title: '读取推荐线索', description: '读取当前页面的候选人卡片并应用基础工作年限条件。', verification: '只使用当前可见卡片，人数不超过参数上限。' },
        { id: 'read-details', title: '逐一读取详情', description: '打开候选人详情，确认只有一份可见简历后提取结构化字段。', verification: '姓名可信，详情与选中的候选人卡片一致。' },
        { id: 'save-boss', title: '保存到人才库', description: '将人才资料关联当前岗位和 BOSS 来源后保存。', verification: '重新读取人才库后字段和来源关联正确。' },
      ],
      permissions: ['读取 BOSS 推荐页', '读取可见简历详情', '写入本地人才库', '禁止自动打招呼', '禁止发送消息', '禁止下载附件'],
      successCriteria: ['保存人数不超过参数上限', '姓名不得为活跃状态文案', '每条记录关联当前岗位和 BOSS 来源', '未向候选人发起沟通'],
      failureStrategy: '卡片、详情或平台状态变化时停止当前动作，重新读取页面；无法确认候选人身份时不保存并交回 Agent。',
    },
  },
  {
    key: 'read-and-save-open-resume', name: '读取当前简历并补全人才资料', category: 'general', platform: null, status: 'enabled', executionMode: 'agent_guided', riskLevel: 'local_write',
    description: '读取当前唯一可见的猎聘或 BOSS 简历，提取结构化字段并补全人才库记录。',
    definition: {
      taskType: 'analyze', parameters: [],
      steps: [
        { id: 'single-detail', title: '确认当前简历', description: '检查当前页面只有一份可见简历详情。', verification: '可见详情数量严格等于一。' },
        { id: 'extract-profile', title: '提取人才字段', description: '读取姓名、公司、职位、所在地、期望职位和期望薪资。', verification: '姓名不是在线、今天活跃等状态文案。' },
        { id: 'persist-profile', title: '保存人才资料', description: '关联当前岗位和来源平台，写入人才库。', verification: '重新读取人才库后字段与页面证据一致。' },
      ],
      permissions: ['读取可见简历详情', '写入本地人才库', '禁止联系候选人', '禁止下载附件'],
      successCriteria: ['姓名通过可信格式校验', '结构化字段按页面证据保存', '候选人关联当前岗位和来源平台'],
      failureStrategy: '详情缺失、存在多份详情或姓名不可信时停止保存并请求用户核对页面。',
    },
  },
  {
    key: 'analyze-open-resume', name: '按岗位逐项分析当前简历', category: 'general', platform: null, status: 'enabled', executionMode: 'agent_guided', riskLevel: 'local_write',
    description: '依据当前岗位条件逐项引用简历证据，生成等待招聘人员复核的分析草稿。',
    definition: {
      taskType: 'analyze', parameters: [],
      steps: [
        { id: 'read-job', title: '读取岗位版本', description: '读取当前岗位和逐项技能条件。', verification: '保存岗位指纹用于提交前复核。' },
        { id: 'read-resume', title: '读取当前简历', description: '读取当前唯一可见简历并生成内容指纹。', verification: '提交前简历指纹保持一致。' },
        { id: 'assess', title: '逐项分析证据', description: '对每项要求区分明确证据、相关线索、未知和明确不符。', verification: '每项岗位条件恰好对应一条结论，引用原文确实存在。' },
        { id: 'save-draft', title: '保存分析草稿', description: '保存草稿并等待招聘人员人工复核。', verification: '草稿未触发任何对外沟通。' },
      ],
      permissions: ['读取当前岗位', '读取可见简历详情', '写入本地分析草稿', '禁止联系候选人'],
      successCriteria: ['岗位与简历指纹未变化', '每项条件都有结论', '证据引用来自简历原文', '结果保持待人工复核'],
      failureStrategy: '岗位或简历变化时放弃旧草稿，重新读取后再分析。',
    },
  },
]

const LEARNED_STEP_LIBRARY: Record<string, RecruitmentSkillStep> = {
  context: { id: 'check-context', title: '检查执行上下文', description: '确认当前岗位、平台和任务输入仍然有效。', verification: '岗位、平台与任务要求一致。' },
  search: { id: 'search', title: '搜索与筛选', description: '按任务条件搜索并应用页面筛选。', verification: '搜索词和筛选标签与任务输入一致。' },
  read: { id: 'read', title: '读取页面或简历', description: '读取当前可见结果和所需详情。', verification: '读取对象与当前任务目标一致。' },
  analyze: { id: 'analyze', title: '分析并形成证据', description: '基于可见信息完成结构化分析。', verification: '结论可追溯到任务条目或页面证据。' },
  save: { id: 'save', title: '保存结构化结果', description: '将确认后的结果写入 AgentHR 或工作目录。', verification: '重新读取后字段或文件存在且内容一致。' },
  report: { id: 'report', title: '生成报告', description: '汇总证据并生成任务要求的报告。', verification: '报告路径已关联任务且内容可读取。' },
  contact: { id: 'contact', title: '执行外部沟通', description: '按授权向候选人发送消息或打招呼。', verification: '发送对象、内容和回执均已记录。' },
}

function canonicalOperations(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['context', /岗位|上下文|登录|平台/u],
    ['search', /搜索|检索|筛选|关键词|推荐页/u],
    ['read', /读取|查看|打开|简历|候选人|页面/u],
    ['analyze', /分析|评估|匹配|证据|结论/u],
    ['save', /保存|写入|人才库|落盘|关联/u],
    ['report', /报告|汇总|导出|markdown|\.md\b/iu],
    ['contact', /打招呼|发送消息|联系候选人|沟通/u],
  ]
  const found = rules.filter(([, pattern]) => pattern.test(text)).map(([key]) => key)
  return found.length ? found : ['context', 'analyze']
}

function skillFingerprint(platform: Platform | null, taskType: TaskType, operations: string[]): string {
  return createHash('sha256').update(JSON.stringify([platform ?? 'general', taskType, [...new Set(operations)].sort()])).digest('hex')
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
      CREATE TABLE IF NOT EXISTS recruitment_skills (
        id TEXT PRIMARY KEY, skill_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general', platform TEXT, status TEXT NOT NULL, active_version INTEGER NOT NULL, execution_mode TEXT NOT NULL,
        risk_level TEXT NOT NULL, run_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'builtin', fingerprint TEXT,
        source_task_count INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS recruitment_skill_versions (
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES recruitment_skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, definition_json TEXT NOT NULL, change_summary TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(skill_id, version)
      );
      CREATE TABLE IF NOT EXISTS recruitment_skill_runs (
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES recruitment_skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, task_id TEXT NOT NULL REFERENCES recruitment_tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL, parameters_json TEXT NOT NULL, result_summary TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS recruitment_skill_sources (
        skill_id TEXT NOT NULL REFERENCES recruitment_skills(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES recruitment_tasks(id) ON DELETE CASCADE,
        source_kinds_json TEXT NOT NULL, evidence_summary TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS recruitment_skill_run_steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES recruitment_skill_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, step_index INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '', error_code TEXT, error_message TEXT, started_at TEXT, finished_at TEXT,
        UNIQUE(run_id, step_id)
      );
      CREATE INDEX IF NOT EXISTS candidate_sources_candidate ON candidate_sources(candidate_id);
      CREATE INDEX IF NOT EXISTS applications_job ON applications(job_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_updated ON recruitment_tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_entries_created ON recruitment_task_entries(task_id, created_at);
      CREATE INDEX IF NOT EXISTS events_created ON recruitment_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS platform_validations_created ON platform_validations(created_at DESC);
      CREATE INDEX IF NOT EXISTS candidate_greetings_created ON candidate_greetings(created_at DESC);
      CREATE INDEX IF NOT EXISTS recruitment_skills_updated ON recruitment_skills(updated_at DESC);
      CREATE INDEX IF NOT EXISTS recruitment_skill_runs_started ON recruitment_skill_runs(skill_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS recruitment_skill_sources_task ON recruitment_skill_sources(task_id);
      CREATE INDEX IF NOT EXISTS recruitment_skill_steps_run ON recruitment_skill_run_steps(run_id, step_index);
    `)
    const candidateColumns = this.db.prepare('PRAGMA table_info(candidates)').all()
    if (!candidateColumns.some(column => column.name === 'notes')) this.db.exec("ALTER TABLE candidates ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    const taskColumns = this.db.prepare('PRAGMA table_info(recruitment_tasks)').all()
    if (!taskColumns.some(column => column.name === 'description')) this.db.exec("ALTER TABLE recruitment_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''")
    if (!taskColumns.some(column => column.name === 'result_summary')) this.db.exec("ALTER TABLE recruitment_tasks ADD COLUMN result_summary TEXT NOT NULL DEFAULT ''")
    if (!taskColumns.some(column => column.name === 'last_browser_url')) this.db.exec('ALTER TABLE recruitment_tasks ADD COLUMN last_browser_url TEXT')
    if (!taskColumns.some(column => column.name === 'run_count')) this.db.exec('ALTER TABLE recruitment_tasks ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0')
    const skillColumns = this.db.prepare('PRAGMA table_info(recruitment_skills)').all()
    if (!skillColumns.some(column => column.name === 'category')) this.db.exec("ALTER TABLE recruitment_skills ADD COLUMN category TEXT NOT NULL DEFAULT 'general'")
    if (!skillColumns.some(column => column.name === 'origin')) this.db.exec("ALTER TABLE recruitment_skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin'")
    if (!skillColumns.some(column => column.name === 'fingerprint')) this.db.exec('ALTER TABLE recruitment_skills ADD COLUMN fingerprint TEXT')
    if (!skillColumns.some(column => column.name === 'source_task_count')) this.db.exec('ALTER TABLE recruitment_skills ADD COLUMN source_task_count INTEGER NOT NULL DEFAULT 0')
    if (!skillColumns.some(column => column.name === 'consecutive_failures')) this.db.exec('ALTER TABLE recruitment_skills ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0')
    this.db.exec("UPDATE recruitment_skills SET category = CASE platform WHEN 'boss' THEN 'boss' WHEN 'liepin' THEN 'liepin' ELSE 'general' END WHERE category = 'general' AND platform IS NOT NULL")
    this.db.exec("UPDATE recruitment_tasks SET description = title WHERE description = ''")
    this.seedRecruitmentSkills()
    this.ensureSkillFingerprints()
    this.extractSkillDraftsFromHistory()
  }

  private seedRecruitmentSkills(): void {
    const now = new Date().toISOString()
    for (const builtin of BUILTIN_SKILLS) {
      if (this.db.prepare('SELECT id FROM recruitment_skills WHERE skill_key = ?').get(builtin.key)) continue
      const id = randomUUID()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(`INSERT INTO recruitment_skills
          (id, skill_key, name, description, category, platform, status, active_version, execution_mode, risk_level,
           run_count, success_count, last_run_at, created_at, updated_at, origin, fingerprint, source_task_count, consecutive_failures)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, NULL, ?, ?, 'builtin', NULL, 0, 0)`).run(id, builtin.key, builtin.name, builtin.description,
            builtin.category, builtin.platform, builtin.status, builtin.executionMode, builtin.riskLevel, now, now)
        this.db.prepare('INSERT INTO recruitment_skill_versions VALUES (?, ?, 1, ?, ?, ?)')
          .run(randomUUID(), id, JSON.stringify(builtin.definition), '内置技能初始版本', now)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }

  private ensureSkillFingerprints(): void {
    const rows = this.db.prepare('SELECT id, platform, active_version FROM recruitment_skills WHERE fingerprint IS NULL').all()
    for (const row of rows) {
      const version = this.db.prepare('SELECT definition_json FROM recruitment_skill_versions WHERE skill_id = ? AND version = ?')
        .get(String(row.id), Number(row.active_version))
      if (!version) continue
      const definition = JSON.parse(String(version.definition_json)) as RecruitmentSkillDefinition
      const stepText = definition.steps.map(step => `${step.id} ${step.title} ${step.description}`).join(' ')
      const fingerprint = skillFingerprint(row.platform === null ? null : row.platform as Platform, definition.taskType, canonicalOperations(stepText))
      this.db.prepare('UPDATE recruitment_skills SET fingerprint = ? WHERE id = ?').run(fingerprint, String(row.id))
    }
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
        this.db.prepare(`UPDATE candidates SET display_name = ?,
          current_company = CASE WHEN ? <> '' THEN ? ELSE current_company END,
          current_title = CASE WHEN ? <> '' THEN ? ELSE current_title END,
          location = CASE WHEN ? <> '' THEN ? ELSE location END,
          expected_salary = CASE WHEN ? <> '' THEN ? ELSE expected_salary END,
          expected_position = CASE WHEN ? <> '' THEN ? ELSE expected_position END,
          updated_at = ? WHERE id = ?`).run(displayName,
            boundedText(resume.currentCompany, 200), boundedText(resume.currentCompany, 200),
            boundedText(resume.currentTitle, 200), boundedText(resume.currentTitle, 200),
            boundedText(resume.location, 120), boundedText(resume.location, 120),
            boundedText(resume.expectedSalary, 120), boundedText(resume.expectedSalary, 120),
            boundedText(resume.expectedPosition, 200), boundedText(resume.expectedPosition, 200), now, candidateId)
        this.db.prepare('UPDATE candidate_sources SET source_url = ?, last_seen_at = ? WHERE source_key = ?').run(boundedText(sourceUrl, 2000), now, sourceKey)
      } else {
        this.db.prepare(`INSERT INTO candidates
          (id, display_name, current_company, current_title, location, expected_salary, expected_position, stage, tags_json, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidateId, displayName,
            boundedText(resume.currentCompany, 200), boundedText(resume.currentTitle, 200), boundedText(resume.location, 120),
            boundedText(resume.expectedSalary, 120), boundedText(resume.expectedPosition, 200), 'screening', '[]', '', now, now)
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
    const runRow = this.db.prepare('SELECT * FROM recruitment_skill_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(id)
    const skillRun = runRow ? this.decodeSkillRun(runRow) : undefined
    return { task, entries, files, skillRun, skillSteps: skillRun ? this.listSkillRunSteps(skillRun.id) : undefined }
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
      const skillRun = this.db.prepare("SELECT id, skill_id, status FROM recruitment_skill_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(id)
      if (skillRun && (status === 'completed' || status === 'failed' || status === 'cancelled')) {
        const runStatus = status === 'completed' ? 'completed' : 'failed'
        const summary = status === 'completed' ? boundedText(current.resultSummary, 1000) : errorMessage ?? '任务已取消'
        this.db.prepare('UPDATE recruitment_skill_runs SET status = ?, result_summary = ?, finished_at = ? WHERE id = ?')
          .run(runStatus, summary, now, String(skillRun.id))
        if (status === 'completed') {
          this.db.prepare('UPDATE recruitment_skills SET success_count = success_count + 1, consecutive_failures = 0, updated_at = ? WHERE id = ?')
            .run(now, String(skillRun.skill_id))
        } else if (status === 'failed') {
          this.db.prepare(`UPDATE recruitment_skills SET consecutive_failures = consecutive_failures + 1,
            status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'needs_repair' ELSE status END, updated_at = ? WHERE id = ?`)
            .run(now, String(skillRun.skill_id))
          const failureCount = Number(this.db.prepare('SELECT consecutive_failures FROM recruitment_skills WHERE id = ?').get(String(skillRun.skill_id))?.consecutive_failures ?? 0)
          if (failureCount >= 3) this.event('skill.needs_repair', 'skill', String(skillRun.skill_id), `技能连续失败 ${failureCount} 次，已标记 needs_repair`, now)
        }
        this.event('skill.run_finished', 'skill', String(skillRun.skill_id), `技能运行${status === 'completed' ? '成功' : '失败'}：${current.title}`, now)
      }
      this.event('task.status_changed', 'task', id, `任务状态：${current.status} -> ${status}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (status === 'completed') this.extractSkillDraftFromTask(id)
    return this.getTask(id)
  }

  extractSkillDraftsFromHistory(limit = 200): { created: number; merged: number; skipped: number } {
    const rows = this.db.prepare("SELECT id FROM recruitment_tasks WHERE status = 'completed' ORDER BY finished_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(1000, limit)))
    const result = { created: 0, merged: 0, skipped: 0 }
    for (const row of rows) result[this.extractSkillDraftFromTask(String(row.id))] += 1
    return result
  }

  extractSkillDraftFromTask(taskId: string): 'created' | 'merged' | 'skipped' {
    const detail = this.getTaskDetail(taskId)
    if (detail.task.status !== 'completed' || (!detail.entries.length && !detail.task.resultSummary.trim())) return 'skipped'
    const existingSource = this.db.prepare('SELECT skill_id FROM recruitment_skill_sources WHERE task_id = ? LIMIT 1').get(taskId)
    if (existingSource) return 'skipped'
    const sourceKinds: string[] = [...new Set(detail.entries.map(entry => entry.kind === 'browser_result' ? 'dsh_operation' : 'conversation'))]
    if (!sourceKinds.length) sourceKinds.push('successful_task')
    const text = [detail.task.title, detail.task.description, detail.task.resultSummary,
      ...detail.entries.flatMap(entry => [entry.title, entry.content])].join('\n')
    const operations = canonicalOperations(text)
    const fingerprint = skillFingerprint(detail.task.platform, detail.task.type, operations)
    const linkedRun = this.db.prepare('SELECT skill_id FROM recruitment_skill_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId)
    let skillId = linkedRun ? String(linkedRun.skill_id) : ''
    if (!skillId) {
      const exact = this.db.prepare('SELECT id FROM recruitment_skills WHERE fingerprint = ? LIMIT 1').get(fingerprint)
      if (exact) skillId = String(exact.id)
    }
    if (!skillId) {
      let best: { id: string; score: number } | undefined
      for (const skill of this.listSkills().filter(item => item.definition.taskType === detail.task.type
        && (item.platform === detail.task.platform || item.platform === null || detail.task.platform === null))) {
        const candidate = new Set(canonicalOperations(skill.definition.steps.map(step => `${step.id} ${step.title} ${step.description}`).join(' ')))
        const incoming = new Set(operations)
        const intersection = [...incoming].filter(item => candidate.has(item)).length
        const score = intersection / new Set([...incoming, ...candidate]).size
        if (score >= 0.6 && (!best || score > best.score)) best = { id: skill.id, score }
      }
      skillId = best?.id ?? ''
    }
    const now = new Date().toISOString()
    if (!skillId) {
      skillId = randomUUID()
      const steps = operations.map(operation => LEARNED_STEP_LIBRARY[operation]).filter(Boolean)
      const definition: RecruitmentSkillDefinition = {
        taskType: detail.task.type, parameters: [], steps,
        permissions: ['读取任务上下文和已有结果', operations.some(item => item === 'save' || item === 'report') ? '写入本地业务数据或工作文件' : '只读执行',
          operations.includes('contact') ? '外部沟通必须再次取得用户明确授权' : '禁止未经授权的外部沟通'],
        successCriteria: ['任务结果已写回同一任务', '关键结论具有可复核证据', '最终任务状态为完成'],
        failureStrategy: '保存失败步骤、错误信息和已有证据，从该断点自动回退给 Agent 继续诊断。',
      }
      const category: RecruitmentSkillCategory = detail.task.platform === 'boss' ? 'boss' : detail.task.platform === 'liepin' ? 'liepin' : 'general'
      const safeName = boundedText(detail.task.title.replace(/\b20\d{2}[-/]?\d{0,2}[-/]?\d{0,2}\b/gu, '').replace(/\s+/gu, ' '), 100) || '历史任务沉淀技能'
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(`INSERT INTO recruitment_skills
          (id, skill_key, name, description, category, platform, status, active_version, execution_mode, risk_level,
           run_count, success_count, last_run_at, created_at, updated_at, origin, fingerprint, source_task_count, consecutive_failures)
          VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, 'agent_guided', ?, 0, 0, NULL, ?, ?, 'task_history', ?, 1, 0)`)
          .run(skillId, `learned-${fingerprint.slice(0, 16)}`, safeName, `从成功任务中自动提取；已合并 1 条历史证据。`, category,
            detail.task.platform, operations.some(item => item === 'save' || item === 'report') ? 'local_write' : operations.includes('contact') ? 'external_action' : 'read_only',
            now, now, fingerprint)
        this.db.prepare('INSERT INTO recruitment_skill_versions VALUES (?, ?, 1, ?, ?, ?)')
          .run(randomUUID(), skillId, JSON.stringify(definition), `从成功任务「${detail.task.title}」自动提取`, now)
        this.db.prepare('INSERT INTO recruitment_skill_sources VALUES (?, ?, ?, ?, ?)')
          .run(skillId, taskId, JSON.stringify(sourceKinds), boundedText(detail.task.resultSummary || detail.entries.at(-1)?.content, 1000), now)
        this.event('skill.draft_extracted', 'skill', skillId, `从成功任务提取技能草稿：${safeName}`, now)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      return 'created'
    }
    const skill = this.getSkill(skillId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO recruitment_skill_sources VALUES (?, ?, ?, ?, ?)')
        .run(skillId, taskId, JSON.stringify(sourceKinds), boundedText(detail.task.resultSummary || detail.entries.at(-1)?.content, 1000), now)
      if (inserted.changes === 0) { this.db.exec('COMMIT'); return 'skipped' }
      let activeVersion = skill.activeVersion
      if (skill.status === 'draft') {
        const known = new Set(canonicalOperations(skill.definition.steps.map(step => `${step.id} ${step.title} ${step.description}`).join(' ')))
        const missing = operations.filter(operation => !known.has(operation))
        if (missing.length) {
          activeVersion += 1
          const definition = { ...skill.definition, steps: [...skill.definition.steps, ...missing.map(operation => LEARNED_STEP_LIBRARY[operation]).filter(Boolean)] }
          this.db.prepare('INSERT INTO recruitment_skill_versions VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), skillId, activeVersion, JSON.stringify(definition), `合并成功任务「${detail.task.title}」中的新步骤`, now)
        }
      }
      this.db.prepare(`UPDATE recruitment_skills SET active_version = ?, source_task_count = source_task_count + 1,
        description = CASE WHEN origin = 'task_history' THEN '从成功任务中自动提取；已合并 ' || (source_task_count + 1) || ' 条历史证据。' ELSE description END,
        updated_at = ? WHERE id = ?`).run(activeVersion, now, skillId)
      this.event('skill.source_merged', 'skill', skillId, `合并相似成功任务：${detail.task.title}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return 'merged'
  }

  listEvents(limit = 100): RecruitmentEvent[] {
    return this.db.prepare('SELECT * FROM recruitment_events ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))).map(row => ({
      id: String(row.id), type: String(row.type), entityType: row.entity_type as RecruitmentEvent['entityType'], entityId: String(row.entity_id), summary: String(row.summary), createdAt: String(row.created_at),
    }))
  }

  private decodeSkill(row: Record<string, unknown>): RecruitmentSkill {
    const version = this.db.prepare('SELECT definition_json FROM recruitment_skill_versions WHERE skill_id = ? AND version = ?')
      .get(String(row.id), Number(row.active_version))
    if (!version) throw new Error('技能版本不存在')
    return {
      id: String(row.id), key: String(row.skill_key), name: String(row.name), description: String(row.description), category: row.category as RecruitmentSkillCategory,
      platform: row.platform === null ? null : row.platform as Platform, status: row.status as RecruitmentSkillStatus,
      activeVersion: Number(row.active_version), executionMode: row.execution_mode as RecruitmentSkillExecutionMode,
      riskLevel: row.risk_level as RecruitmentSkill['riskLevel'], definition: JSON.parse(String(version.definition_json)) as RecruitmentSkillDefinition,
      runCount: Number(row.run_count), successCount: Number(row.success_count), lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
      sourceTaskCount: Number(row.source_task_count ?? 0), consecutiveFailures: Number(row.consecutive_failures ?? 0),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  getSkill(id: string): RecruitmentSkill {
    assertUuid(id, '技能 ID')
    const row = this.db.prepare('SELECT * FROM recruitment_skills WHERE id = ?').get(id)
    if (!row) throw new Error('招聘技能不存在')
    return this.decodeSkill(row)
  }

  listSkills(): RecruitmentSkill[] {
    return this.db.prepare("SELECT * FROM recruitment_skills ORDER BY CASE status WHEN 'enabled' THEN 0 ELSE 1 END, updated_at DESC")
      .all().map(row => this.decodeSkill(row))
  }

  setSkillStatus(id: string, status: 'enabled' | 'disabled', expectedUpdatedAt: string): RecruitmentSkill {
    if (status !== 'enabled' && status !== 'disabled') throw new Error('技能状态无效')
    const current = this.getSkill(id)
    if (current.updatedAt !== expectedUpdatedAt) throw new Error('招聘技能已变化，请刷新后重试')
    if (current.status === status) return current
    const now = nextTimestamp(current.updatedAt)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE recruitment_skills SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
      this.event('skill.status_changed', 'skill', id, `技能状态：${current.status} -> ${status}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getSkill(id)
  }

  startSkillRun(skillId: string, taskId: string, value: unknown): RecruitmentSkillRun {
    const skill = this.getSkill(skillId)
    assertUuid(taskId, '任务 ID')
    if (skill.status !== 'enabled') throw new Error('招聘技能未启用')
    if (!this.db.prepare('SELECT id FROM recruitment_tasks WHERE id = ?').get(taskId)) throw new Error('招聘任务不存在')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能参数格式无效')
    const input = value as Record<string, unknown>
    const knownKeys = new Set(skill.definition.parameters.map(parameter => parameter.key))
    if (Object.keys(input).some(key => !knownKeys.has(key))) throw new Error('包含技能未声明的参数')
    const parameters: Record<string, string | number | boolean> = {}
    for (const parameter of skill.definition.parameters) {
      const candidate = input[parameter.key] ?? parameter.defaultValue
      if (parameter.type === 'text') {
        const safe = boundedText(candidate, 300)
        if (parameter.required && !safe) throw new Error(`${parameter.label}不能为空`)
        parameters[parameter.key] = safe
      } else if (parameter.type === 'number') {
        const safe = typeof candidate === 'number' ? candidate : Number(candidate)
        if (!Number.isFinite(safe) || safe < 0 || safe > 1000) throw new Error(`${parameter.label}必须是 0 到 1000 之间的数字`)
        parameters[parameter.key] = safe
      } else {
        if (typeof candidate !== 'boolean') throw new Error(`${parameter.label}必须是布尔值`)
        parameters[parameter.key] = candidate
      }
    }
    const now = nextTimestamp(skill.updatedAt), run: RecruitmentSkillRun = {
      id: randomUUID(), skillId, version: skill.activeVersion, taskId, status: 'running', parameters,
      resultSummary: '', startedAt: now, finishedAt: null,
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO recruitment_skill_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(run.id, run.skillId, run.version, run.taskId, run.status, JSON.stringify(run.parameters), run.resultSummary, run.startedAt, run.finishedAt)
      const insertStep = this.db.prepare(`INSERT INTO recruitment_skill_run_steps
        (id, run_id, step_id, step_index, title, status, evidence, error_code, error_message, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, 'pending', '', NULL, NULL, NULL, NULL)`)
      skill.definition.steps.forEach((step, index) => insertStep.run(randomUUID(), run.id, step.id, index, step.title))
      this.db.prepare('UPDATE recruitment_skills SET run_count = run_count + 1, last_run_at = ?, updated_at = ? WHERE id = ?').run(now, now, skillId)
      this.event('skill.run_started', 'skill', skillId, `已通过技能 v${skill.activeVersion} 创建任务：${skill.name}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return run
  }

  listSkillRuns(skillId: string, limit = 20): RecruitmentSkillRun[] {
    assertUuid(skillId, '技能 ID')
    return this.db.prepare('SELECT * FROM recruitment_skill_runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(skillId, Math.max(1, Math.min(100, limit))).map(row => this.decodeSkillRun(row))
  }

  private decodeSkillRun(row: Record<string, unknown>): RecruitmentSkillRun {
    return { id: String(row.id), skillId: String(row.skill_id), version: Number(row.version), taskId: String(row.task_id),
      status: row.status as RecruitmentSkillRun['status'], parameters: JSON.parse(String(row.parameters_json)) as RecruitmentSkillRun['parameters'],
      resultSummary: String(row.result_summary), startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at) }
  }

  listSkillRunSteps(runId: string): RecruitmentSkillRunStep[] {
    assertUuid(runId, '技能运行 ID')
    return this.db.prepare('SELECT * FROM recruitment_skill_run_steps WHERE run_id = ? ORDER BY step_index ASC').all(runId).map(row => ({
      id: String(row.id), runId: String(row.run_id), stepId: String(row.step_id), stepIndex: Number(row.step_index), title: String(row.title),
      status: row.status as RecruitmentSkillStepStatus, evidence: String(row.evidence ?? ''),
      errorCode: row.error_code === null ? null : String(row.error_code), errorMessage: row.error_message === null ? null : String(row.error_message),
      startedAt: row.started_at === null ? null : String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }))
  }

  recordSkillStep(taskId: string, value: unknown): SkillStepUpdateResult {
    assertUuid(taskId, '任务 ID')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能步骤回执格式无效')
    const input = value as Record<string, unknown>
    const stepId = boundedText(input.stepId, 120)
    const status = input.status as RecruitmentSkillStepStatus
    if (!stepId || !['running', 'completed', 'failed', 'skipped'].includes(status)) throw new Error('技能步骤状态无效')
    const runRow = this.db.prepare("SELECT * FROM recruitment_skill_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(taskId)
    if (!runRow) throw new Error('任务没有正在执行的技能运行')
    const run = this.decodeSkillRun(runRow)
    const step = this.db.prepare('SELECT * FROM recruitment_skill_run_steps WHERE run_id = ? AND step_id = ?').get(run.id, stepId)
    if (!step) throw new Error('技能步骤不存在')
    const current = step.status as RecruitmentSkillStepStatus
    const allowed = current === 'pending' ? ['running', 'completed', 'failed', 'skipped']
      : current === 'running' ? ['completed', 'failed'] : []
    if (!allowed.includes(status)) throw new Error(`技能步骤不能从 ${current} 变为 ${status}`)
    const evidence = boundedText(input.evidence, 4000)
    const errorCode = status === 'failed' ? boundedText(input.errorCode, 80) || 'SKILL_STEP_FAILED' : null
    const errorMessage = status === 'failed' ? boundedText(input.errorMessage, 1000) || '技能步骤执行失败' : null
    if ((status === 'completed' || status === 'failed') && !evidence) throw new Error('完成或失败步骤必须提供证据')
    const now = new Date().toISOString()
    const startedAt = current === 'pending' && status === 'running' ? now : step.started_at === null ? now : String(step.started_at)
    const finishedAt = status === 'completed' || status === 'failed' || status === 'skipped' ? now : null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE recruitment_skill_run_steps SET status = ?, evidence = ?, error_code = ?, error_message = ?,
        started_at = ?, finished_at = ? WHERE id = ?`).run(status, evidence, errorCode, errorMessage, startedAt, finishedAt, String(step.id))
      if (status === 'failed') {
        this.db.prepare('INSERT INTO recruitment_task_entries VALUES (?, ?, ?, ?, ?, NULL, ?)')
          .run(randomUUID(), taskId, 'note', `技能断点：${String(step.title)}`, `步骤 ${stepId} 失败。\n错误：${errorCode} - ${errorMessage}\n证据：${evidence}`, now)
        this.db.prepare("UPDATE recruitment_tasks SET status = 'paused', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?")
          .run(errorCode, errorMessage, now, taskId)
        this.event('skill.step_failed', 'skill', run.skillId, `步骤失败并回退 Agent：${String(step.title)}`, now)
      } else this.event('skill.step_updated', 'skill', run.skillId, `步骤 ${String(step.title)}：${status}`, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    const fallbackPrompt = status === 'failed'
      ? `技能执行在步骤「${String(step.title)}」失败并已保存断点。请读取任务 ${taskId}，基于失败证据诊断原因，从该步骤继续；不要重复已完成步骤。` : null
    return { run, steps: this.listSkillRunSteps(run.id), fallbackRequired: status === 'failed', fallbackPrompt }
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
