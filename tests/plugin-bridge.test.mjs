import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AssessmentStore } from '../dist/main/assessments.js'
import { AgentHrBridge } from '../dist/main/bridge.js'
import { apply } from '../dist/plugin/index.js'

test('AgentHR tools read synthetic role and resume, then save an evidence-backed draft through the bridge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthr-plugin-bridge-'))
  const store = new AssessmentStore(home)
  const brief = { role: '动物造模研发', requirements: '脑科学研发背景', criteria: ['熟悉 tMCAO 动物造模'] }
  const resume = { name: '模拟候选人', text: '从事脑科学研究，熟悉动物实验；简历未说明具体造模方法。' }
  const browserActions = []
  const candidateFingerprint = 'a'.repeat(64)
  const bridge = new AgentHrBridge(
    () => ({ platform: 'liepin', url: 'https://lpt.liepin.com/recommend', title: '模拟页面', loading: false }),
    async () => [{ cardIndex: 0, name: resume.name, skills: '动物实验', summary: '脑科学研发', fingerprint: candidateFingerprint }],
    async () => resume,
    () => brief,
    async value => store.save(value, resume, brief, 'liepin'),
    async value => { browserActions.push(['job', value]); return { ...value, id: 'synthetic' } },
    async platform => { browserActions.push(['navigate', platform]); return { platform, page: 'recommend' } },
    async fingerprint => { browserActions.push(['candidate', fingerprint]); return { opened: true, name: resume.name } },
    async () => ({ snapshotId: 'abc123', platform: 'liepin', path: '/search', frames: [{ frame: 'main', text: 'Java 工程师', controls: [{ ref: 'main:e0', kind: 'search_input', label: '搜索职位' }] }] }),
    async value => { browserActions.push(['browser', value]); return { done: true, action: value.action } },
    async () => [{ id: 'task-1', type: 'search', status: 'queued' }],
    async value => { browserActions.push(['task', value]); return { id: 'task-2', status: 'queued', ...value } },
    async () => { browserActions.push(['capture']); return [{ id: 'candidate-1', displayName: resume.name }] },
    async () => [{ id: 'candidate-1', displayName: resume.name, updatedAt: '2026-09-15T00:00:00.000Z' }],
    async value => { browserActions.push(['candidate-update', value]); return { id: value.candidateId, updatedAt: '2026-09-15T00:00:01.000Z', ...value.changes } },
    undefined,
    () => ({ path: home, name: 'workspace' }),
    async id => ({ task: { id, title: '寻找候选人', description: '寻找上海 Java 候选人' }, entries: [], files: [] }),
    async (id, value) => ({ task: { id }, entries: [{ id: 'entry-1', ...value }], files: [] }),
  )
  const address = await bridge.start()
  const oldUrl = process.env.AGENTHR_BRIDGE_URL
  const oldToken = process.env.AGENTHR_BRIDGE_TOKEN
  process.env.AGENTHR_BRIDGE_URL = address.url
  process.env.AGENTHR_BRIDGE_TOKEN = address.token
  try {
    const registered = new Map()
    apply({
      tools: { register: tool => registered.set(tool.name, tool) },
      systemPrompt: { section: () => {} },
    })
    const signal = new AbortController().signal
    const call = async (name, args = {}) => JSON.parse(await registered.get(name).execute(args, { signal }))
    const job = (await call('agenthr_get_job_brief')).jobBrief
    assert.deepEqual((await call('agenthr_get_workspace')).workspace, { path: home, name: 'workspace' })
    const current = (await call('agenthr_read_open_resume')).resume
    assert.equal((await call('agenthr_browser_status')).page, 'recommend')
    assert.equal((await call('agenthr_browser_status')).url, 'https://lpt.liepin.com/recommend')
    assert.equal((await call('agenthr_browser_snapshot')).snapshot.frames[0].text, 'Java 工程师')
    assert.equal((await call('agenthr_browser_action', { snapshotId: 'abc123', action: 'fill', ref: 'main:e0', value: 'Java 工程师' })).result.done, true)
    assert.equal((await call('agenthr_list_visible_candidates')).candidates[0].fingerprint, candidateFingerprint)
    assert.equal((await call('agenthr_save_visible_candidates')).candidates[0].id, 'candidate-1')
    const storedCandidate = (await call('agenthr_list_candidates')).candidates[0]
    assert.equal(storedCandidate.id, 'candidate-1')
    assert.deepEqual((await call('agenthr_update_candidate', { candidateId: storedCandidate.id, expectedUpdatedAt: storedCandidate.updatedAt, changes: { tags: ['重点'] } })).candidate.tags, ['重点'])
    assert.equal(job.role, brief.role)
    assert.equal(current.name, resume.name)
    assert.match(current.sourceDigest, /^[0-9a-f]{64}$/u)
    assert.match(job.jobBriefDigest, /^[0-9a-f]{64}$/u)
    const draft = {
      sourceDigest: current.sourceDigest,
      jobBriefDigest: job.jobBriefDigest,
      findings: [{
        criterion: brief.criteria[0], verdict: 'related_clue', evidenceQuote: '熟悉动物实验',
        reasoning: '有动物实验经验，但未明确 tMCAO 操作。', questionDraft: '请问是否亲自做过 tMCAO 造模？',
      }],
    }
    const saved = await call('agenthr_save_assessment_draft', draft)
    assert.equal(saved.card.reviewStatus, 'draft')
    assert.deepEqual(store.list()[0].findings, draft.findings)
    const created = await call('agenthr_save_job_brief', { mode: 'create', ...brief })
    assert.equal(created.jobBrief.id, 'synthetic')
    assert.equal((await call('agenthr_list_tasks')).tasks[0].id, 'task-1')
    const createdTask = await call('agenthr_create_task', { type: 'search', platform: 'liepin', title: '寻找候选人', description: '寻找上海 Java 候选人' })
    assert.equal(createdTask.task.id, 'task-2')
    assert.equal((await call('agenthr_get_task', { taskId: createdTask.task.id })).taskDetail.task.description, '寻找上海 Java 候选人')
    assert.equal((await call('agenthr_append_task_result', { taskId: createdTask.task.id, kind: 'analysis', title: '分析', content: '完成初步分析' })).taskDetail.entries[0].content, '完成初步分析')
    assert.equal((await call('agenthr_open_recommendations', { platform: 'liepin' })).result.page, 'recommend')
    assert.equal((await call('agenthr_open_candidate_preview', { fingerprint: candidateFingerprint })).result.opened, true)
    assert.deepEqual(browserActions.map(action => action[0]), ['browser', 'capture', 'candidate-update', 'job', 'task', 'navigate', 'candidate'])
    assert.equal([...registered.keys()].some(name => /send|message/iu.test(name)), false)
  } finally {
    if (oldUrl === undefined) delete process.env.AGENTHR_BRIDGE_URL
    else process.env.AGENTHR_BRIDGE_URL = oldUrl
    if (oldToken === undefined) delete process.env.AGENTHR_BRIDGE_TOKEN
    else process.env.AGENTHR_BRIDGE_TOKEN = oldToken
    await bridge.stop()
    store.close()
    rmSync(home, { recursive: true, force: true })
  }
})
