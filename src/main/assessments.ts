import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OpenResume } from './adapters/liepin.js'
import { jobBriefDigest, type JobBrief } from './job-brief.js'
import type { Platform } from './platforms.js'

export type Verdict = 'explicit_evidence' | 'related_clue' | 'unknown' | 'explicit_mismatch'
export type ReviewStatus = 'draft' | 'needs_clarification' | 'reviewed'

export interface CriterionFinding {
  criterion: string
  verdict: Verdict
  evidenceQuote: string
  reasoning: string
  questionDraft: string
}

export interface AssessmentDraft {
  sourceDigest: string
  jobBriefDigest: string
  findings: CriterionFinding[]
}

export interface AssessmentCard extends AssessmentDraft {
  id: string
  createdAt: string
  platform: Platform
  candidateName: string
  role: string
  requirements: string
  reviewStatus: ReviewStatus
  reviewUpdatedAt: string | null
}

/** Ephemeral content fingerprint. It is not a stable candidate identity. */
export function resumeDigest(resume: OpenResume): string {
  return createHash('sha256').update(JSON.stringify([resume.name, resume.text])).digest('hex')
}

function parseDraft(value: unknown, resume: OpenResume, brief: JobBrief): AssessmentDraft {
  if (typeof value !== 'object' || value === null) throw new Error('分析卡片格式无效')
  const draft = value as Record<string, unknown>
  const verdicts: Verdict[] = ['explicit_evidence', 'related_clue', 'unknown', 'explicit_mismatch']
  if (typeof draft.sourceDigest !== 'string' || draft.sourceDigest !== resumeDigest(resume)) throw new Error('简历已变化，请重新读取后分析')
  if (typeof draft.jobBriefDigest !== 'string' || draft.jobBriefDigest !== jobBriefDigest(brief)) throw new Error('岗位条件已变化，请重新读取后分析')
  if (!resume.name.trim()) throw new Error('当前简历缺少可核对的候选人姓名')
  if (!Array.isArray(draft.findings) || draft.findings.length !== brief.criteria.length) throw new Error('每项技能条件都需要一条判断')
  const findings: CriterionFinding[] = draft.findings.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new Error(`第 ${index + 1} 项分析条目格式无效`)
    const finding = value as Record<string, unknown>
    if (finding.criterion !== brief.criteria[index]) throw new Error(`第 ${index + 1} 项分析条目与当前岗位技能条件不一致`)
    if (!verdicts.includes(finding.verdict as Verdict)) throw new Error(`第 ${index + 1} 项证据分类无效`)
    if (typeof finding.evidenceQuote !== 'string' || finding.evidenceQuote.length > 500
      || typeof finding.reasoning !== 'string' || !finding.reasoning.trim() || finding.reasoning.length > 2000
      || typeof finding.questionDraft !== 'string' || finding.questionDraft.length > 500) throw new Error(`第 ${index + 1} 项分析条目内容无效`)
    const verdict = finding.verdict as Verdict
    const evidenceQuote = finding.evidenceQuote.trim()
    if (/薪资|工资|薪酬|待遇|求职意向|岗位意向|入职意向|salary|compensation|job intent/iu.test(finding.questionDraft)) {
      throw new Error(`第 ${index + 1} 项问题草稿仅确认岗位技能，不能追问薪资或求职意向`)
    }
    if (verdict === 'unknown' && evidenceQuote) throw new Error(`第 ${index + 1} 项未知技能不能附会证据`)
    if (verdict !== 'unknown' && (!evidenceQuote || !resume.text.includes(evidenceQuote))) {
      throw new Error(`第 ${index + 1} 项证据原文未出现在当前简历中`)
    }
    return { criterion: finding.criterion as string, verdict, evidenceQuote, reasoning: finding.reasoning.trim(), questionDraft: finding.questionDraft.trim() }
  })
  return {
    sourceDigest: draft.sourceDigest,
    jobBriefDigest: draft.jobBriefDigest,
    findings,
  }
}

/** Only draft analysis is persisted. Raw resume text and site credentials are never stored. */
export class AssessmentStore {
  private readonly db: DatabaseSync

  constructor(userData: string) {
    const path = join(userData, 'agenthr-assessments.sqlite')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assessments (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        platform TEXT NOT NULL,
        candidate_name TEXT NOT NULL,
        role TEXT NOT NULL,
        requirements TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        job_brief_digest TEXT NOT NULL,
        verdict TEXT NOT NULL,
        evidence_quote TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        question_draft TEXT NOT NULL,
        findings_json TEXT NOT NULL DEFAULT '',
        review_status TEXT NOT NULL,
        review_updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS assessments_created_at ON assessments(created_at DESC);
    `)
    const columns = this.db.prepare('PRAGMA table_info(assessments)').all()
    if (!columns.some(column => column.name === 'job_brief_digest')) {
      this.db.exec("ALTER TABLE assessments ADD COLUMN job_brief_digest TEXT NOT NULL DEFAULT ''")
    }
    if (!columns.some(column => column.name === 'findings_json')) {
      this.db.exec("ALTER TABLE assessments ADD COLUMN findings_json TEXT NOT NULL DEFAULT ''")
    }
    if (!columns.some(column => column.name === 'review_updated_at')) {
      this.db.exec('ALTER TABLE assessments ADD COLUMN review_updated_at TEXT')
    }
  }

  save(value: unknown, resume: OpenResume, brief: JobBrief, platform: Platform): AssessmentCard {
    if (platform !== 'liepin' && platform !== 'boss') throw new Error('分析来源平台无效')
    const draft = parseDraft(value, resume, brief)
    const findingsJson = JSON.stringify(draft.findings)
    const existing = this.db.prepare(`SELECT id FROM assessments WHERE platform = ?
      AND source_digest = ? AND job_brief_digest = ? AND findings_json = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(platform, draft.sourceDigest, draft.jobBriefDigest, findingsJson)
    if (existing) return this.get(String(existing.id))
    const card: AssessmentCard = {
      ...draft,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      platform,
      candidateName: resume.name,
      role: brief.role,
      requirements: brief.requirements,
      reviewStatus: 'draft',
      reviewUpdatedAt: null,
    }
    const first = card.findings[0]
    this.db.prepare(`INSERT INTO assessments (
      id, created_at, platform, candidate_name, role, requirements, source_digest, job_brief_digest,
      verdict, evidence_quote, reasoning, question_draft, findings_json, review_status, review_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      card.id, card.createdAt, card.platform, card.candidateName, card.role, card.requirements,
      card.sourceDigest, card.jobBriefDigest, first.verdict, first.evidenceQuote, first.reasoning, first.questionDraft,
      findingsJson, card.reviewStatus, card.reviewUpdatedAt,
    )
    return card
  }

  private decode(row: Record<string, unknown>): AssessmentCard {
    const status = String(row.review_status)
    const platform = String(row.platform)
    if (platform !== 'liepin' && platform !== 'boss') throw new Error('分析卡片来源平台无效')
    if (status !== 'draft' && status !== 'needs_clarification' && status !== 'reviewed') {
      throw new Error('分析卡片复核状态无效')
    }
    return {
      id: String(row.id), createdAt: String(row.created_at), platform,
      candidateName: String(row.candidate_name), role: String(row.role), requirements: String(row.requirements),
      sourceDigest: String(row.source_digest), jobBriefDigest: String(row.job_brief_digest),
      findings: row.findings_json ? JSON.parse(String(row.findings_json)) as CriterionFinding[] : [{
        criterion: String(row.requirements), verdict: row.verdict as Verdict,
        evidenceQuote: String(row.evidence_quote), reasoning: String(row.reasoning), questionDraft: String(row.question_draft),
      }], reviewStatus: status, reviewUpdatedAt: row.review_updated_at === null ? null : String(row.review_updated_at),
    }
  }

  get(id: string): AssessmentCard {
    const row = this.db.prepare(`SELECT id, created_at, platform, candidate_name, role, requirements,
      source_digest, job_brief_digest, verdict, evidence_quote, reasoning, question_draft,
      findings_json, review_status, review_updated_at FROM assessments WHERE id = ?`).get(id)
    if (!row) throw new Error('分析卡片不存在')
    return this.decode(row)
  }

  list(limit = 100, jobDigest?: string): AssessmentCard[] {
    const bounded = Math.max(1, Math.min(100, limit))
    const columns = `id, created_at, platform, candidate_name, role, requirements,
      source_digest, job_brief_digest, verdict, evidence_quote, reasoning, question_draft,
      findings_json, review_status, review_updated_at`
    const rows = jobDigest === undefined
      ? this.db.prepare(`SELECT ${columns} FROM assessments ORDER BY created_at DESC, id DESC LIMIT ?`).all(bounded)
      : this.db.prepare(`SELECT ${columns} FROM assessments WHERE job_brief_digest = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(jobDigest, bounded)
    return rows.map(row => this.decode(row))
  }

  setReviewStatus(id: string, status: ReviewStatus): AssessmentCard {
    if (status !== 'draft' && status !== 'needs_clarification' && status !== 'reviewed') {
      throw new Error('复核状态无效')
    }
    const current = this.get(id)
    if (current.reviewStatus === status) return current
    this.db.prepare('UPDATE assessments SET review_status = ?, review_updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
    return this.get(id)
  }

  close(): void { this.db.close() }
}
