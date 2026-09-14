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
    const current = (await call('agenthr_read_open_resume')).resume
    assert.equal((await call('agenthr_browser_status')).page, 'recommend')
    assert.equal((await call('agenthr_browser_snapshot')).snapshot.frames[0].text, 'Java 工程师')
    assert.equal((await call('agenthr_browser_action', { snapshotId: 'abc123', action: 'fill', ref: 'main:e0', value: 'Java 工程师' })).result.done, true)
    assert.equal((await call('agenthr_list_visible_candidates')).candidates[0].fingerprint, candidateFingerprint)
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
    assert.equal((await call('agenthr_open_recommendations', { platform: 'liepin' })).result.page, 'recommend')
    assert.equal((await call('agenthr_open_candidate_preview', { fingerprint: candidateFingerprint })).result.opened, true)
    assert.deepEqual(browserActions.map(action => action[0]), ['browser', 'job', 'navigate', 'candidate'])
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
