import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { extractBossPreviews, extractOpenBossResume, hasSingleVisibleBossFrame } from '../dist/main/adapters/boss.js'
import { parseCandidatePreviews, parseOpenResume } from '../dist/main/adapters/liepin.js'

test('BOSS recommends only the current card list, with bounded fields and no interaction', () => {
  const { document } = parseHTML(`
    <div class="card-list"><div class="candidate-card-wrap">
      <span class="name">示例候选人</span>
      <div class="base-info join-text-wrap">动物实验经验</div>
      <div class="content join-text-wrap">脑缺血模型研究</div>
    </div></div>
    <div class="candidate-card-wrap"><span class="name">列表外候选人</span></div>
    <div class="card-list" hidden><div class="candidate-card-wrap"><span class="name">隐藏旧候选人</span></div></div>
  `)
  const expected = [{ cardIndex: 0, name: '示例候选人', skills: '动物实验经验', summary: '脑缺血模型研究' }]
  assert.deepEqual(extractBossPreviews(document), expected)
  const inPage = new Function('document', `return (${extractBossPreviews.toString()})(document)`)
  assert.deepEqual(parseCandidatePreviews(inPage(document)), expected)
})

test('BOSS resume is read only from one visible detail frame and its resume root', () => {
  const { document: recommend } = parseHTML(`<iframe src="/web/frame/c-resume/example"></iframe>`)
  const resumeSelector = "iframe[src*='/web/frame/c-resume/']"
  assert.equal(hasSingleVisibleBossFrame(recommend, resumeSelector), true)
  const inPageFrame = new Function('document', 'selector', `return (${hasSingleVisibleBossFrame.toString()})(document, selector)`)
  assert.equal(inPageFrame(recommend, resumeSelector), true)
  const { document: hidden } = parseHTML(`<iframe src="/web/frame/c-resume/example" hidden></iframe>`)
  assert.equal(hasSingleVisibleBossFrame(hidden, resumeSelector), false)
  const { document: hiddenParent } = parseHTML(`<section hidden><iframe src="/web/frame/c-resume/example"></iframe></section>`)
  assert.equal(hasSingleVisibleBossFrame(hiddenParent, resumeSelector), false)
  const { document: hiddenRecommend } = parseHTML(`<section aria-hidden="true"><iframe name="recommendFrame"></iframe></section>`)
  assert.equal(hasSingleVisibleBossFrame(hiddenRecommend, "iframe[name='recommendFrame']"), false)
  const { document: multiple } = parseHTML(`<iframe src="/web/frame/c-resume/one"></iframe><iframe src="/web/frame/c-resume/two"></iframe>`)
  assert.equal(hasSingleVisibleBossFrame(multiple, resumeSelector), false)

  const { document: detail } = parseHTML(`<div>页面背景不属于简历</div><div id="resume"><h1 class="name">示例候选人</h1><section>熟悉动物实验；tMCAO 操作经验未知。</section></div>`)
  const expected = { name: '示例候选人', text: '示例候选人熟悉动物实验；tMCAO 操作经验未知。',
    currentCompany: '', currentTitle: '', location: '', expectedSalary: '', expectedPosition: '' }
  assert.deepEqual(extractOpenBossResume(detail), expected)
  const inDetail = new Function('document', `return (${extractOpenBossResume.toString()})(document)`)
  assert.deepEqual(parseOpenResume(inDetail(detail)), expected)
  assert.equal(inDetail(detail).text.includes('页面背景'), false)
  const { document: noResume } = parseHTML('<div>页面背景文本</div>')
  assert.equal(extractOpenBossResume(noResume), null)
  const { document: closedResume } = parseHTML('<div hidden><div id="resume">隐藏的旧候选人完整简历资料</div></div>')
  assert.equal(extractOpenBossResume(closedResume), null)
})
