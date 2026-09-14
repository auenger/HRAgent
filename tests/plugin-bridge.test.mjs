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
  const bridge = new AgentHrBridge(
    () => ({ platform: 'liepin', url: 'https://lpt.liepin.com/recommend', title: '模拟页面', loading: false }),
    async () => [{ cardIndex: 0, name: resume.name, skills: '动物实验', summary: '脑科学研发' }],
    async () => resume,
    () => brief,
    async value => store.save(value, resume, brief, 'liepin'),
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
