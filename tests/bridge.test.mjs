import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentHrBridge } from '../dist/main/bridge.js'
import { resumeDigest } from '../dist/main/assessments.js'
import { jobBriefDigest } from '../dist/main/job-brief.js'

test('DSH bridge is loopback-only and rejects unauthenticated requests', async () => {
  const bridge = new AgentHrBridge(
    () => ({ platform: 'liepin', url: 'https://lpt.liepin.com/login?token=private#step', title: '登录', loading: false }),
    async () => [{ cardIndex: 0, name: '示例候选人', skills: '动物实验', summary: '研发经验' }],
    async () => ({ name: '示例候选人', text: '参与动物实验和脑科学研究，具体造模方法需要进一步确认。' }),
    () => ({ role: '动物造模研发', requirements: '动物造模背景', criteria: ['熟悉 tMCAO 动物造模'] }),
    async () => ({ id: 'synthetic-card', reviewStatus: 'draft' }),
    undefined, undefined, undefined, undefined, undefined,
    async () => [{ id: 'task-1', type: 'search', status: 'queued' }],
    async value => ({ id: 'task-2', status: 'queued', ...value }),
    async () => [{ id: 'candidate-1', displayName: '示例候选人' }],
    async () => [{ id: 'candidate-1', displayName: '示例候选人', updatedAt: '2026-09-15T00:00:00.000Z' }],
    async value => ({ id: value.candidateId, updatedAt: '2026-09-15T00:00:01.000Z', ...value.changes }),
    async value => ({ id: 'greeting-1', result: 'greeted', ...value }),
    () => ({ path: '/tmp/agenthr-workspace', name: 'agenthr-workspace' }),
    id => ({ task: { id, title: '测试任务', description: '明确输入' }, entries: [], files: [] }),
    (id, value) => ({ task: { id }, entries: [{ id: 'entry-1', ...value }], files: [] }),
  )
  const address = await bridge.start()
  try {
    assert.equal(new URL(address.url).hostname, '127.0.0.1')
    const denied = await fetch(`${address.url}/v1/browser/status`)
    assert.equal(denied.status, 401)
    const accepted = await fetch(`${address.url}/v1/browser/status`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { browser: { platform: 'liepin', page: 'login', loading: false, active: true, title: '登录', url: 'https://lpt.liepin.com/login', path: '/login' } })
    const workspace = await fetch(`${address.url}/v1/workspace`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.deepEqual(await workspace.json(), { workspace: { path: '/tmp/agenthr-workspace', name: 'agenthr-workspace' } })
    const taskDetail = await fetch(`${address.url}/v1/tasks/detail?id=task-1`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.deepEqual(await taskDetail.json(), { taskDetail: { task: { id: 'task-1', title: '测试任务', description: '明确输入' }, entries: [], files: [] } })
    const taskEntry = await fetch(`${address.url}/v1/tasks/entry`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', kind: 'analysis', title: '结论', content: '分析完成' }),
    })
    assert.equal((await taskEntry.json()).taskDetail.entries[0].content, '分析完成')
    const unknown = await fetch(`${address.url}/v1/browser/unknown`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(unknown.status, 404)
    const candidates = await fetch(`${address.url}/v1/candidates/visible`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.deepEqual(await candidates.json(), { candidates: [{ cardIndex: 0, name: '示例候选人', skills: '动物实验', summary: '研发经验' }] })
    const resumeDenied = await fetch(`${address.url}/v1/resume/open`)
    assert.equal(resumeDenied.status, 401)
    const resume = await fetch(`${address.url}/v1/resume/open`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(resume.status, 200)
    const sampleResume = { name: '示例候选人', text: '参与动物实验和脑科学研究，具体造模方法需要进一步确认。' }
    assert.deepEqual(await resume.json(), { resume: { ...sampleResume, sourceDigest: resumeDigest(sampleResume) } })
    const brief = await fetch(`${address.url}/v1/job-brief`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(brief.status, 200)
    assert.deepEqual(await brief.json(), { jobBrief: { role: '动物造模研发', requirements: '动物造模背景', criteria: ['熟悉 tMCAO 动物造模'], jobBriefDigest: jobBriefDigest({ role: '动物造模研发', requirements: '动物造模背景', criteria: ['熟悉 tMCAO 动物造模'] }) } })
    const unauthorizedSave = await fetch(`${address.url}/v1/assessments`, { method: 'POST', body: '{}' })
    assert.equal(unauthorizedSave.status, 401)
    const saved = await fetch(`${address.url}/v1/assessments`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDigest: 'synthetic' }),
    })
    assert.equal(saved.status, 201)
    assert.deepEqual(await saved.json(), { card: { id: 'synthetic-card', reviewStatus: 'draft' } })
    const oversized = await fetch(`${address.url}/v1/assessments`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: 'x'.repeat(48_001),
    })
    assert.equal(oversized.status, 413)
    const tasks = await fetch(`${address.url}/v1/tasks`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.deepEqual(await tasks.json(), { tasks: [{ id: 'task-1', type: 'search', status: 'queued' }] })
    const createdTask = await fetch(`${address.url}/v1/tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'search', title: '寻找 Java 候选人' }),
    })
    assert.equal(createdTask.status, 201)
    assert.deepEqual(await createdTask.json(), { task: { id: 'task-2', status: 'queued', type: 'search', title: '寻找 Java 候选人' } })
    const captured = await fetch(`${address.url}/v1/candidates/capture`, { method: 'POST', headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(captured.status, 201)
    assert.deepEqual(await captured.json(), { candidates: [{ id: 'candidate-1', displayName: '示例候选人' }] })
    const storedCandidates = await fetch(`${address.url}/v1/candidates`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.deepEqual(await storedCandidates.json(), { candidates: [{ id: 'candidate-1', displayName: '示例候选人', updatedAt: '2026-09-15T00:00:00.000Z' }] })
    const updatedCandidate = await fetch(`${address.url}/v1/candidates/update`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'candidate-1', expectedUpdatedAt: '2026-09-15T00:00:00.000Z', changes: { tags: ['重点'] } }),
    })
    assert.equal(updatedCandidate.status, 200)
    assert.deepEqual(await updatedCandidate.json(), { candidate: { id: 'candidate-1', updatedAt: '2026-09-15T00:00:01.000Z', tags: ['重点'] } })
    const greeted = await fetch(`${address.url}/v1/candidates/greet`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assessmentId: 'assessment-1', fingerprint: 'f'.repeat(64), confirmed: true }),
    })
    assert.equal(greeted.status, 201)
    assert.deepEqual(await greeted.json(), { greeting: { id: 'greeting-1', result: 'greeted', assessmentId: 'assessment-1', fingerprint: 'f'.repeat(64), confirmed: true } })
  } finally {
    await bridge.stop()
  }
})

test('DSH bridge preserves a bounded resume diagnostic', async () => {
  const bridge = new AgentHrBridge(
    () => undefined,
    async () => [],
    async () => { throw new Error('Synthetic private page details must not reach the client') },
    () => null,
    async () => { throw new Error('Synthetic private analysis details must not reach the client') },
  )
  const address = await bridge.start()
  try {
    const response = await fetch(`${address.url}/v1/resume/open`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'Synthetic private page details must not reach the client' })
    const save = await fetch(`${address.url}/v1/assessments`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(save.status, 409)
    assert.deepEqual(await save.json(), { error: 'Synthetic private analysis details must not reach the client' })
  } finally {
    await bridge.stop()
  }
})

test('DSH bridge preserves actionable browser errors for the Agent', async () => {
  const bridge = new AgentHrBridge(
    () => ({ platform: 'boss', url: 'https://www.zhipin.com/web/geek/job', title: '人才搜索', loading: false }),
    async () => [], async () => ({ name: '', text: 'not used' }), () => null,
    async () => { throw new Error('not used') }, undefined, undefined, undefined,
    async () => ({ snapshotId: 'snapshot-1', frames: [] }),
    async () => { throw new Error('下拉选项已经变化') },
  )
  const address = await bridge.start()
  try {
    const response = await fetch(`${address.url}/v1/browser/action`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snapshot-1', action: 'select', ref: 'main:e2', value: 'sh' }),
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: '下拉选项已经变化' })
  } finally {
    await bridge.stop()
  }
})
