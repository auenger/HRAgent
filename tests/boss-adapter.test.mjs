import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { extractBossPreviews, extractOpenBossResume, hasSingleVisibleBossResumeFrame } from '../dist/main/adapters/boss.js'
import { parseCandidatePreviews, parseOpenResume } from '../dist/main/adapters/liepin.js'

test('BOSS recommends only the current card list, with bounded fields and no interaction', () => {
  const { document } = parseHTML(`
    <div class="card-list"><div class="candidate-card-wrap">
      <span class="name">示例候选人</span>
      <div class="base-info join-text-wrap">动物实验经验</div>
      <div class="content join-text-wrap">脑缺血模型研究</div>
    </div></div>
    <div class="candidate-card-wrap"><span class="name">列表外候选人</span></div>
  `)
  const expected = [{ cardIndex: 0, name: '示例候选人', skills: '动物实验经验', summary: '脑缺血模型研究' }]
  assert.deepEqual(extractBossPreviews(document), expected)
  const inPage = new Function('document', `return (${extractBossPreviews.toString()})(document)`)
  assert.deepEqual(parseCandidatePreviews(inPage(document)), expected)
})

test('BOSS resume is read only from one visible detail frame and its resume root', () => {
  const { document: recommend } = parseHTML(`<iframe src="/web/frame/c-resume/example"></iframe>`)
  assert.equal(hasSingleVisibleBossResumeFrame(recommend), true)
  const inPageFrame = new Function('document', `return (${hasSingleVisibleBossResumeFrame.toString()})(document)`)
  assert.equal(inPageFrame(recommend), true)
  const { document: hidden } = parseHTML(`<iframe src="/web/frame/c-resume/example" hidden></iframe>`)
  assert.equal(hasSingleVisibleBossResumeFrame(hidden), false)
  const { document: multiple } = parseHTML(`<iframe src="/web/frame/c-resume/one"></iframe><iframe src="/web/frame/c-resume/two"></iframe>`)
  assert.equal(hasSingleVisibleBossResumeFrame(multiple), false)

  const { document: detail } = parseHTML(`<div>页面背景不属于简历</div><div id="resume"><h1 class="name">示例候选人</h1><section>熟悉动物实验；tMCAO 操作经验未知。</section></div>`)
  const expected = { name: '示例候选人', text: '示例候选人熟悉动物实验；tMCAO 操作经验未知。' }
  assert.deepEqual(extractOpenBossResume(detail), expected)
  const inDetail = new Function('document', `return (${extractOpenBossResume.toString()})(document)`)
  assert.deepEqual(parseOpenResume(inDetail(detail)), expected)
  assert.equal(inDetail(detail).text.includes('页面背景'), false)
  const { document: noResume } = parseHTML('<div>页面背景文本</div>')
  assert.equal(extractOpenBossResume(noResume), null)
})
