import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RecruitmentStore } from '../dist/main/recruitment-store.js'

test('candidate sources persist without merging people across platforms by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-recruitment-'))
  const store = new RecruitmentStore(dir)
  const jobId = '11111111-1111-4111-8111-111111111111'
  const preview = { cardIndex: 0, name: '林清禾', skills: 'Java · Spring Boot', summary: '电商平台研发', fingerprint: 'a'.repeat(64) }
  try {
    const first = store.captureVisible([preview], 'liepin', 'https://lpt.liepin.com/recommend', jobId)
    assert.equal(first.length, 1)
    assert.deepEqual(first[0].sourcePlatforms, ['liepin'])
    assert.deepEqual(first[0].jobIds, [jobId])
    assert.equal(store.captureVisible([preview], 'liepin', 'https://lpt.liepin.com/recommend', jobId)[0].id, first[0].id)
    const boss = store.captureVisible([{ ...preview, fingerprint: 'b'.repeat(64) }], 'boss', 'https://www.zhipin.com/web/geek/recommend', jobId)
    assert.notEqual(boss[0].id, first[0].id)
    assert.equal(store.listCandidates().length, 2)
    assert.equal(store.listEvents().filter(event => event.type === 'candidate.captured').length, 2)
    const updated = store.updateCandidate(first[0].id, store.getCandidate(first[0].id).updatedAt, { currentCompany: '澄明科技', tags: ['后端', 'Java'], notes: '等待确认到岗时间。' })
    assert.equal(updated.currentCompany, '澄明科技')
    assert.deepEqual(updated.tags, ['后端', 'Java'])
    assert.throws(() => store.updateCandidate(updated.id, first[0].updatedAt, { notes: '过期写入' }), /已变化/)
    const merged = store.mergeCandidates(updated.id, boss[0].id, updated.updatedAt, boss[0].updatedAt)
    assert.equal(merged.sourceCount, 2)
    assert.deepEqual(merged.sourcePlatforms, ['boss', 'liepin'])
    assert.equal(store.listCandidates().length, 1)
    assert.ok(store.listEvents().some(event => event.type === 'candidate.merged'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resume sources, applications, tasks and audit events are durable and bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-domain-'))
  const store = new RecruitmentStore(dir)
  const jobId = '22222222-2222-4222-8222-222222222222'
  try {
    const resume = { name: '周砚', text: '五年 Java 服务端研发经验。', currentCompany: '澄明科技', currentTitle: '高级 Java 工程师',
      location: '上海', expectedSalary: '35-45k', expectedPosition: 'Java 技术专家' }
    const candidate = store.captureResume(resume, 'liepin', 'https://lpt.liepin.com/recommend', jobId, 'assessment-1')
    assert.equal(candidate.stage, 'screening')
    assert.deepEqual({ company: candidate.currentCompany, title: candidate.currentTitle, location: candidate.location,
      salary: candidate.expectedSalary, position: candidate.expectedPosition },
    { company: '澄明科技', title: '高级 Java 工程师', location: '上海', salary: '35-45k', position: 'Java 技术专家' })
    assert.deepEqual(store.listCandidates(100, jobId).map(item => item.id), [candidate.id])
    assert.equal(store.captureResume({ ...resume, currentTitle: '' }, 'liepin', 'https://lpt.liepin.com/recommend', jobId).id, candidate.id)
    assert.equal(store.getCandidate(candidate.id).currentTitle, '高级 Java 工程师')
    assert.equal(store.setApplicationStage(candidate.id, jobId, 'interview').stage, 'interview')
    assert.ok(store.listEvents().some(event => event.type === 'application.stage_changed'))
    const task = store.createTask({ jobId, type: 'search', platform: 'liepin', title: '寻找 Java 后端候选人', description: '在猎聘寻找上海 Java 后端候选人，并汇总匹配证据。', workspacePaths: ['inputs/job.md'] })
    assert.equal(task.status, 'queued')
    assert.equal(store.setTaskStatus(task.id, 'running').startedAt !== null, true)
    const completed = store.setTaskStatus(task.id, 'completed')
    assert.equal(completed.progress, 100)
    assert.equal(completed.finishedAt !== null, true)
    assert.deepEqual(store.listTasks(100, jobId).map(item => item.id), [task.id])
    const detail = store.getTaskDetail(task.id)
    assert.equal(detail.task.description, '在猎聘寻找上海 Java 后端候选人，并汇总匹配证据。')
    assert.deepEqual(detail.files.map(file => file.path), ['inputs/job.md'])
    const withResult = store.appendTaskEntry(task.id, { kind: 'browser_result', title: '首批候选人', content: '发现 3 名候选人。', workspacePaths: ['outputs/candidates.md'] }, 'https://lpt.liepin.com/search')
    assert.equal(withResult.entries[0].sourceUrl, 'https://lpt.liepin.com/search')
    assert.equal(withResult.task.runCount, 1)
    assert.deepEqual(withResult.files.map(file => file.path), ['inputs/job.md', 'outputs/candidates.md'])
    assert.equal(store.beginTaskRun(task.id).runCount, 2)
    const failedTask = store.createTask({ jobId, type: 'analyze', platform: 'liepin', title: '读取候选人简历', description: '读取当前简历并分析。' })
    const failed = store.setTaskStatus(failedTask.id, 'failed', failedTask.updatedAt, { code: 'PAGE_CHANGED', message: '候选人详情已关闭' })
    assert.equal(failed.errorCode, 'PAGE_CHANGED')
    assert.equal(failed.errorMessage, '候选人详情已关闭')
    const retried = store.setTaskStatus(failed.id, 'queued', failed.updatedAt)
    assert.equal(retried.errorCode, null)
    assert.equal(retried.errorMessage, null)
    assert.ok(store.listEvents().some(event => event.type === 'assessment.saved'))
    assert.equal(store.recordEvent('job.updated', 'job', jobId, '更新岗位：Java 后端').entityType, 'job')
    assert.throws(() => store.createTask({ jobId: 'not-an-id', type: 'search', title: '错误任务', description: '输入' }), /岗位 ID 无效/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('candidate stages remain independent for each linked job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-application-stage-'))
  const store = new RecruitmentStore(dir)
  const firstJob = '33333333-3333-4333-8333-333333333333'
  const secondJob = '44444444-4444-4444-8444-444444444444'
  const preview = { cardIndex: 0, name: '沈知遥', skills: 'Node.js', summary: '平台研发', fingerprint: 'c'.repeat(64) }
  try {
    const candidate = store.captureVisible([preview], 'liepin', 'https://lpt.liepin.com/recommend', firstJob)[0]
    store.captureVisible([preview], 'liepin', 'https://lpt.liepin.com/recommend', secondJob)
    store.setApplicationStage(candidate.id, firstJob, 'interview', store.getCandidate(candidate.id).updatedAt)
    assert.equal(store.listCandidates(100, firstJob)[0].stage, 'interview')
    assert.equal(store.listCandidates(100, secondJob)[0].stage, 'lead')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('platform validation history stores bounded outcomes without page content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-platform-validation-'))
  const store = new RecruitmentStore(dir)
  const runId = '55555555-5555-4555-8555-555555555555'
  try {
    const passed = store.recordPlatformValidation('liepin', 'candidate_list', 'passed', '候选人列表读取成功，共 8 条可见线索。', runId)
    assert.equal(passed.status, 'passed')
    assert.deepEqual(store.listPlatformValidations(), [passed])
    assert.throws(() => store.recordPlatformValidation('liepin', 'candidate_list', 'passed', '', runId), /摘要不能为空/)
    assert.throws(() => store.recordPlatformValidation('other', 'candidate_list', 'passed', '错误平台', runId), /格式无效/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('built-in recruitment skills are versioned, controllable and create audited runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-skills-'))
  const store = new RecruitmentStore(dir)
  const jobId = '99999999-9999-4999-8999-999999999999'
  try {
    const skills = store.listSkills()
    assert.equal(skills.length, 4)
    assert.deepEqual(Object.fromEntries(['general', 'boss', 'liepin'].map(category => [category, skills.filter(item => item.category === category).length])),
      { general: 2, boss: 1, liepin: 1 })
    const skill = skills.find(item => item.key === 'liepin-search-and-save')
    assert.ok(skill)
    assert.equal(skill.status, 'enabled')
    assert.equal(skill.activeVersion, 1)
    assert.equal(skill.definition.steps.length, 4)
    const disabled = store.setSkillStatus(skill.id, 'disabled', skill.updatedAt)
    assert.equal(disabled.status, 'disabled')
    assert.throws(() => store.setSkillStatus(skill.id, 'enabled', skill.updatedAt), /已变化/)
    const enabled = store.setSkillStatus(skill.id, 'enabled', disabled.updatedAt)
    const task = store.createTask({ jobId, type: 'search', platform: 'liepin', title: enabled.name, description: enabled.description })
    const run = store.startSkillRun(enabled.id, task.id, { keyword: 'Java', city: '上海', maxCandidates: 8, minimumExperienceYears: 3 })
    assert.equal(run.version, 1)
    assert.equal(run.parameters.maxCandidates, 8)
    assert.equal(store.listSkillRuns(enabled.id)[0].taskId, task.id)
    assert.equal(store.getSkill(enabled.id).runCount, 1)
    assert.ok(store.listEvents().some(event => event.type === 'skill.run_started' && event.entityId === enabled.id))
    assert.throws(() => store.startSkillRun(enabled.id, task.id, { keyword: '', city: '上海', maxCandidates: 8 }), /搜索关键词不能为空/)
    store.setTaskStatus(task.id, 'completed')
    assert.equal(store.listSkillRuns(enabled.id)[0].status, 'completed')
    assert.equal(store.getSkill(enabled.id).successCount, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('successful task history is extracted into deduplicated skill drafts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-skill-learning-'))
  const store = new RecruitmentStore(dir)
  const jobId = '12121212-1212-4212-8212-121212121212'
  try {
    for (const suffix of ['A', 'B']) {
      const task = store.createTask({ jobId, type: 'follow_up', platform: 'liepin', title: `候选人跟进报告 ${suffix}`,
        description: '读取候选人已有分析，汇总证据并生成 Markdown 报告，不联系候选人。' })
      store.appendTaskEntry(task.id, { kind: 'analysis', title: '汇总完成', content: `已读取候选人并生成报告 ${suffix}` })
      store.setTaskStatus(task.id, 'completed')
    }
    const learned = store.listSkills().filter(skill => skill.status === 'draft' && skill.definition.taskType === 'follow_up')
    assert.equal(learned.length, 1)
    assert.equal(learned[0].sourceTaskCount, 2)
    assert.ok(learned[0].definition.steps.some(step => step.id === 'report'))
    assert.ok(store.listEvents().some(event => event.type === 'skill.source_merged'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill runs persist step checkpoints and enter needs_repair after three failed runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-skill-repair-'))
  const store = new RecruitmentStore(dir)
  const jobId = '13131313-1313-4313-8313-131313131313'
  try {
    const skill = store.listSkills().find(item => item.key === 'analyze-open-resume')
    assert.ok(skill)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = store.createTask({ jobId, type: 'analyze', title: `分析失败 ${attempt}`, description: '分析当前简历' })
      const run = store.startSkillRun(skill.id, task.id, {})
      const initial = store.listSkillRunSteps(run.id)
      assert.equal(initial.length, skill.definition.steps.length)
      const started = store.recordSkillStep(task.id, { stepId: initial[0].stepId, status: 'running' })
      assert.equal(started.fallbackRequired, false)
      const failed = store.recordSkillStep(task.id, { stepId: initial[0].stepId, status: 'failed', evidence: '页面返回目标不存在', errorCode: 'TARGET_MISSING', errorMessage: '目标控件不存在' })
      assert.equal(failed.fallbackRequired, true)
      assert.match(failed.fallbackPrompt, /不要重复已完成步骤/)
      assert.equal(store.getTask(task.id).status, 'paused')
      store.setTaskStatus(task.id, 'failed', undefined, { code: 'FALLBACK_FAILED', message: 'Agent 回退后仍未恢复' })
    }
    const repaired = store.getSkill(skill.id)
    assert.equal(repaired.consecutiveFailures, 3)
    assert.equal(repaired.status, 'needs_repair')
    assert.ok(store.listEvents().some(event => event.type === 'skill.needs_repair'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BOSS greeting records are durable, audited and deduplicated per job and resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthr-greeting-'))
  const store = new RecruitmentStore(dir)
  const jobId = '66666666-6666-4666-8666-666666666666'
  const assessmentId = '77777777-7777-4777-8777-777777777777'
  const sourceDigest = 'd'.repeat(64)
  try {
    const greeted = store.recordGreeting({ assessmentId, jobId, candidateName: '顾清扬', sourceDigest, result: 'greeted' })
    assert.equal(greeted.result, 'greeted')
    assert.deepEqual(store.getGreetingForAssessment(assessmentId), greeted)
    assert.deepEqual(store.findGreeting(jobId, sourceDigest), greeted)
    assert.equal(store.countGreetedSince(jobId, '2000-01-01T00:00:00.000Z'), 1)
    assert.equal(store.recordGreeting({ assessmentId: '88888888-8888-4888-8888-888888888888', jobId,
      candidateName: '顾清扬', sourceDigest, result: 'greeted' }).id, greeted.id)
    assert.equal(store.listEvents().filter(event => event.type === 'candidate.greeted').length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
