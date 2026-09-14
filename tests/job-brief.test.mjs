import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JobBriefStore, parseJobBrief } from '../dist/main/job-brief.js'

test('multiple job briefs can be created, switched, edited and kept in local configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-job-brief-'))
  try {
    const store = new JobBriefStore(dir)
    assert.equal(store.load(), null)
    const first = store.create({ role: ' 动物造模研发 ', requirements: ' 熟悉 tMCAO；MCAO 仅作相关线索。 ', ignored: 'not persisted' })
    assert.equal(first.role, '动物造模研发')
    assert.equal(first.requirements, '熟悉 tMCAO；MCAO 仅作相关线索。')
    assert.deepEqual(first.criteria, ['熟悉 tMCAO；MCAO 仅作相关线索。'])
    const second = store.create({ role: '小核酸研发', requirements: 'ASO 项目经验' })
    assert.equal(store.list().activeId, second.id)
    assert.deepEqual(store.load(), { role: second.role, requirements: second.requirements, criteria: ['ASO 项目经验'] })
    store.activate(first.id)
    const edited = store.save({ role: first.role, requirements: '动物造模研发背景', criteria: ['独立完成 tMCAO 造模', 'CNS 方向研发经验'] })
    assert.equal(edited.id, first.id)
    assert.equal(store.list().jobs.length, 2)
    assert.equal(store.list().jobs.find(job => job.id === second.id).requirements, 'ASO 项目经验')
    assert.deepEqual(new JobBriefStore(dir).load(), { role: first.role, requirements: '动物造模研发背景', criteria: ['独立完成 tMCAO 造模', 'CNS 方向研发经验'] })
    store.clearActive()
    assert.equal(store.load(), null)
    assert.equal(store.list().jobs.length, 2)
    store.activate(first.id)
    assert.throws(() => store.activate('missing'))
    const raw = readFileSync(join(dir, 'agenthr-jobs.json'), 'utf8')
    assert.equal(raw.includes('ignored'), false)
    assert.throws(() => parseJobBrief({ role: '研发', requirements: '' }))
    assert.throws(() => parseJobBrief({ role: 'x'.repeat(121), requirements: '动物实验' }))
    assert.throws(() => parseJobBrief({ role: '研发', requirements: 'x'.repeat(4001) }))
    assert.throws(() => parseJobBrief({ role: '研发', requirements: '研发', criteria: ['tMCAO', 'tMCAO'] }))
    assert.throws(() => parseJobBrief({ role: '研发', requirements: '研发', criteria: [] }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an existing single job brief is migrated into the job list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-job-migration-'))
  try {
    writeFileSync(join(dir, 'agenthr-job-brief.json'), JSON.stringify({ role: 'CNS 研发', requirements: 'CNS 方向经验' }))
    const store = new JobBriefStore(dir)
    assert.deepEqual(store.load(), { role: 'CNS 研发', requirements: 'CNS 方向经验', criteria: ['CNS 方向经验'] })
    const jobs = store.list()
    assert.equal(jobs.jobs.length, 1)
    assert.equal(jobs.activeId, jobs.jobs[0].id)
    assert.equal(new JobBriefStore(dir).list().activeId, jobs.activeId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a saved job list without criteria gains one legacy criterion per job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-job-criteria-migration-'))
  try {
    const id = '00000000-0000-4000-8000-000000000000'
    writeFileSync(join(dir, 'agenthr-jobs.json'), JSON.stringify({
      version: 1, activeId: id,
      jobs: [{ id, role: 'ASO 研发', requirements: '小核酸项目经验', updatedAt: '2026-01-01T00:00:00.000Z' }],
    }))
    assert.deepEqual(new JobBriefStore(dir).load(), { role: 'ASO 研发', requirements: '小核酸项目经验', criteria: ['小核酸项目经验'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('long legacy requirements remain intact during criterion migration', () => {
  const requirements = '神经科学研发经历；'.repeat(30)
  const brief = parseJobBrief({ role: 'CNS 研发', requirements })
  assert.equal(brief.requirements, requirements)
  assert.deepEqual(brief.criteria, ['岗位核心要求（详见岗位条件）'])
})
