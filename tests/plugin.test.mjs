import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../dist/plugin/index.js'

test('DSH plugin registers evidence analysis and one tightly gated BOSS greeting tool', () => {
  const tools = []
  const prompts = []
  apply({
    tools: { register: tool => tools.push(tool) },
    systemPrompt: { section: section => prompts.push(section) },
  })
  assert.deepEqual(tools.map(tool => tool.name), [
    'agenthr_get_workspace',
    'agenthr_get_job_brief',
    'agenthr_save_job_brief',
    'agenthr_list_tasks',
    'agenthr_create_task',
    'agenthr_get_task',
    'agenthr_append_task_result',
    'agenthr_list_candidates',
    'agenthr_update_candidate',
    'agenthr_browser_status',
    'agenthr_browser_snapshot',
    'agenthr_browser_action',
    'agenthr_open_recommendations',
    'agenthr_list_visible_candidates',
    'agenthr_save_visible_candidates',
    'agenthr_open_candidate_preview',
    'agenthr_read_open_resume',
    'agenthr_save_assessment_draft',
    'agenthr_greet_qualified_boss_candidate',
  ])
  const save = tools.find(tool => tool.name === 'agenthr_save_assessment_draft')
  assert.equal(save.parameters.properties.findings.type, 'array')
  assert.deepEqual(save.parameters.required, ['sourceDigest', 'jobBriefDigest', 'findings'])
  assert.match(prompts[0].text, /每项技能分别判断/)
  assert.match(prompts[0].text, /不要主动向候选人追问或发送消息/)
  assert.match(prompts[0].text, /招聘人员明确要求联系/)
  assert.match(prompts[0].text, /可以读取和汇总当前页面或简历中显示的薪资与求职意向/)
  assert.match(prompts[0].text, /先读取现有任务/)
  assert.match(prompts[0].text, /下载附件、导出或写入新文件属于需要用户明确授权/)
  assert.match(prompts[0].text, /active=true 的 platform 与 url 是当前唯一操作目标/)
  assert.match(prompts[0].text, /不得调用平台切换或打开另一平台的页面/)
  assert.match(prompts[0].text, /不得推断为“只支持推荐页”/)
  assert.match(prompts[0].text, /任务详情是跨对话的持久上下文/)
  assert.deepEqual(tools.find(tool => tool.name === 'agenthr_create_task').parameters.required, ['type', 'title', 'description'])
  assert.equal(tools.find(tool => tool.name === 'agenthr_save_job_brief').parameters.properties.expectedUpdatedAt.type, 'string')
})
