import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../dist/plugin/index.js'

test('DSH plugin registers criterion-level draft analysis without a message tool', () => {
  const tools = []
  const prompts = []
  apply({
    tools: { register: tool => tools.push(tool) },
    systemPrompt: { section: section => prompts.push(section) },
  })
  assert.deepEqual(tools.map(tool => tool.name), [
    'agenthr_get_job_brief',
    'agenthr_save_job_brief',
    'agenthr_browser_status',
    'agenthr_browser_snapshot',
    'agenthr_browser_action',
    'agenthr_open_recommendations',
    'agenthr_list_visible_candidates',
    'agenthr_open_candidate_preview',
    'agenthr_read_open_resume',
    'agenthr_save_assessment_draft',
  ])
  const save = tools.at(-1)
  assert.equal(save.parameters.properties.findings.type, 'array')
  assert.deepEqual(save.parameters.required, ['sourceDigest', 'jobBriefDigest', 'findings'])
  assert.match(prompts[0].text, /每项技能分别判断/)
  assert.match(prompts[0].text, /不要主动向候选人追问或发送消息/)
  assert.match(prompts[0].text, /可以读取和汇总当前页面或简历中显示的薪资与求职意向/)
})
