import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentHrBridge } from '../dist/main/bridge.js'
import { resumeDigest } from '../dist/main/assessments.js'
import { jobBriefDigest } from '../dist/main/job-brief.js'

test('DSH bridge is loopback-only and rejects unauthenticated requests', async () => {
  const bridge = new AgentHrBridge(
    () => ({ platform: 'liepin', url: 'https://lpt.liepin.com/login', title: '登录', loading: false }),
    async () => [{ cardIndex: 0, name: '示例候选人', skills: '动物实验', summary: '研发经验' }],
    async () => ({ name: '示例候选人', text: '参与动物实验和脑科学研究，具体造模方法需要进一步确认。' }),
    () => ({ role: '动物造模研发', requirements: '动物造模背景', criteria: ['熟悉 tMCAO 动物造模'] }),
    async () => ({ id: 'synthetic-card', reviewStatus: 'draft' }),
  )
  const address = await bridge.start()
  try {
    assert.equal(new URL(address.url).hostname, '127.0.0.1')
    const denied = await fetch(`${address.url}/v1/browser/status`)
    assert.equal(denied.status, 401)
    const accepted = await fetch(`${address.url}/v1/browser/status`, { headers: { Authorization: `Bearer ${address.token}` } })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { browser: { platform: 'liepin', page: 'login', loading: false } })
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
  } finally {
    await bridge.stop()
  }
})

test('DSH bridge returns a bounded error when no resume is open', async () => {
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
    assert.deepEqual(await response.json(), { error: '没有可读取的当前简历' })
    const save = await fetch(`${address.url}/v1/assessments`, {
      method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(save.status, 409)
    assert.deepEqual(await save.json(), { error: '分析卡片未保存；请确认当前简历、岗位条件和证据原文' })
  } finally {
    await bridge.stop()
  }
})
