import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { AssessmentStore, resumeDigest } from '../dist/main/assessments.js'
import { jobBriefDigest } from '../dist/main/job-brief.js'

test('assessment drafts require the current resume fingerprint and verbatim evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-assessment-'))
  const store = new AssessmentStore(dir)
  try {
    const resume = { name: '示例候选人', text: '从事脑科学研究，熟悉动物实验。是否亲自做过 tMCAO 未在简历中写明。' }
    const brief = { role: '动物造模研发', requirements: '脑科学研发背景', criteria: ['熟悉 tMCAO 动物造模', 'CNS 方向研发经验'] }
    const first = { criterion: brief.criteria[0], verdict: 'related_clue', evidenceQuote: '熟悉动物实验', reasoning: '动物实验是相关线索，不能证明会 tMCAO。', questionDraft: '请问是否亲自完成过 tMCAO 造模？' }
    const second = { criterion: brief.criteria[1], verdict: 'unknown', evidenceQuote: '', reasoning: '简历没有足够的 CNS 研发经历信息。', questionDraft: '请问是否参与过 CNS 方向项目？' }
    const base = { sourceDigest: resumeDigest(resume), jobBriefDigest: jobBriefDigest(brief), findings: [first, second] }
    assert.throws(() => store.save({ ...base, sourceDigest: '0'.repeat(64) }, resume, brief, 'liepin'), /简历已变化/)
    assert.throws(() => store.save({ ...base, jobBriefDigest: '0'.repeat(64) }, resume, brief, 'liepin'), /岗位条件已变化/)
    assert.throws(() => store.save({ ...base, findings: [first] }, resume, brief, 'liepin'), /每项技能条件/)
    assert.throws(() => store.save({ ...base, findings: [second, first] }, resume, brief, 'liepin'), /技能条件不一致/)
    assert.throws(() => store.save({ ...base, findings: [{ ...first, evidenceQuote: '独立完成 tMCAO 造模' }, second] }, resume, brief, 'liepin'), /证据原文未出现/)
    assert.throws(() => store.save({ ...base, findings: [{ ...first, verdict: 'unknown' }, second] }, resume, brief, 'liepin'), /未知技能不能附会证据/)
    assert.throws(() => store.save({ ...base, findings: [{ ...first, questionDraft: '你的期望薪资是多少？' }, second] }, resume, brief, 'liepin'), /仅确认岗位技能/)
    assert.deepEqual(store.list(), [])
    const card = store.save(base, resume, brief, 'liepin')
    assert.equal(card.reviewStatus, 'draft')
    assert.deepEqual(card.findings, [first, second])
    assert.equal(store.list()[0].id, card.id)
    const raw = readFileSync(join(dir, 'agenthr-assessments.sqlite'))
    assert.equal(raw.includes(Buffer.from(resume.text)), false)
    const unknown = store.save({ ...base, findings: [{ ...first, verdict: 'unknown', evidenceQuote: '' }, second] }, resume, brief, 'liepin')
    assert.equal(unknown.findings[0].evidenceQuote, '')
    assert.equal(store.list().length, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('older single-verdict cards remain readable after findings migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-assessment-migration-'))
  const path = join(dir, 'agenthr-assessments.sqlite')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE assessments (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, platform TEXT NOT NULL,
    candidate_name TEXT NOT NULL, role TEXT NOT NULL, requirements TEXT NOT NULL,
    source_digest TEXT NOT NULL, job_brief_digest TEXT NOT NULL,
    verdict TEXT NOT NULL, evidence_quote TEXT NOT NULL, reasoning TEXT NOT NULL,
    question_draft TEXT NOT NULL, review_status TEXT NOT NULL
  )`)
  old.prepare('INSERT INTO assessments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-card', '2026-01-01T00:00:00.000Z', 'liepin', '模拟候选人', '动物造模研发', '熟悉 tMCAO',
    'resume-hash', 'job-hash', 'related_clue', '动物实验', '需要进一步确认造模方法', '是否做过 tMCAO？', 'draft',
  )
  old.close()
  const store = new AssessmentStore(dir)
  try {
    const [card] = store.list()
    assert.equal(card.id, 'old-card')
    assert.deepEqual(card.findings, [{ criterion: '熟悉 tMCAO', verdict: 'related_clue', evidenceQuote: '动物实验', reasoning: '需要进一步确认造模方法', questionDraft: '是否做过 tMCAO？' }])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('analysis queue scopes exact job snapshots, deduplicates identical drafts and keeps manual review state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-analysis-queue-'))
  const store = new AssessmentStore(dir)
  try {
    const resume = { name: '模拟候选人', text: '参与动物实验和脑科学研究，具体造模方法需要进一步确认。' }
    const firstJob = { role: '动物造模研发', requirements: '脑科学背景', criteria: ['熟悉 tMCAO 动物造模'] }
    const secondJob = { role: 'CNS 研发', requirements: '中枢神经系统研发背景', criteria: ['CNS 项目经验'] }
    const finding = { criterion: firstJob.criteria[0], verdict: 'related_clue', evidenceQuote: '动物实验', reasoning: '造模方法尚未确认。', questionDraft: '是否亲自做过 tMCAO 造模？' }
    const firstDraft = { sourceDigest: resumeDigest(resume), jobBriefDigest: jobBriefDigest(firstJob), findings: [finding] }
    const first = store.save(firstDraft, resume, firstJob, 'liepin')
    assert.equal(store.save(firstDraft, resume, firstJob, 'liepin').id, first.id)
    assert.equal(store.list().length, 1)
    const awaiting = store.setReviewStatus(first.id, 'needs_clarification')
    assert.equal(awaiting.reviewStatus, 'needs_clarification')
    assert.match(awaiting.reviewUpdatedAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(store.save(firstDraft, resume, firstJob, 'liepin').reviewStatus, 'needs_clarification')
    const reviewed = store.setReviewStatus(first.id, 'reviewed')
    assert.equal(store.setReviewStatus(first.id, 'reviewed').reviewUpdatedAt, reviewed.reviewUpdatedAt)
    assert.throws(() => store.setReviewStatus(first.id, 'sent'), /复核状态无效/)
    assert.throws(() => store.setReviewStatus('missing', 'draft'), /不存在/)
    const otherFinding = { criterion: secondJob.criteria[0], verdict: 'related_clue', evidenceQuote: '脑科学研究', reasoning: '方向相关，项目细节待核。', questionDraft: '参与过哪些 CNS 项目？' }
    const second = store.save({ sourceDigest: resumeDigest(resume), jobBriefDigest: jobBriefDigest(secondJob), findings: [otherFinding] }, resume, secondJob, 'liepin')
    assert.notEqual(second.id, first.id)
    assert.deepEqual(store.list(100, jobBriefDigest(firstJob)).map(card => card.id), [first.id])
    assert.deepEqual(store.list(100, jobBriefDigest(secondJob)).map(card => card.id), [second.id])
    const boss = store.save(firstDraft, resume, firstJob, 'boss')
    assert.notEqual(boss.id, first.id)
    assert.equal(boss.platform, 'boss')
    assert.equal(store.get(boss.id).platform, 'boss')
    assert.equal(store.save(firstDraft, resume, firstJob, 'boss').id, boss.id)
    assert.equal(store.list().length, 3)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
