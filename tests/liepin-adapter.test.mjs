import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { extractLiepinPreviews, extractOpenLiepinResume, parseCandidatePreviews, parseOpenResume } from '../dist/main/adapters/liepin.js'

test('Liepin card extraction is read-only, bounded and self-contained for the renderer', () => {
  const { document } = parseHTML(`
    <div data-tlg-elem-id="b_pc_home_hp_res_listcard">
      <b class="nest-resume-personal-name"> 示例候选人 </b>
      <div class="nest-resume-personal-skills">动物实验\n tMCAO 造模</div>
      <p class="resume-description">脑科学研究经验</p>
    </div>
    <div data-tlg-elem-id="other"><b class="nest-resume-personal-name">不应读取</b></div>
  `)
  const expected = [{ cardIndex: 0, name: '示例候选人', skills: '动物实验 tMCAO 造模', summary: '脑科学研究经验' }]
  assert.deepEqual(extractLiepinPreviews(document), expected)
  const inPage = new Function('document', `return (${extractLiepinPreviews.toString()})(document)`)
  assert.deepEqual(inPage(document), expected)
  assert.deepEqual(parseCandidatePreviews(inPage(document)), expected)
  assert.throws(() => parseCandidatePreviews([{ cardIndex: 0, name: 'x', skills: '', summary: '', extra: true }, { cardIndex: -1, name: '', skills: '', summary: '' }]))
})

test('an already-open Liepin resume modal is read without clicking or reading page background', () => {
  const { document } = parseHTML(`
    <div>页面背景不应进入简历内容</div>
    <div class="ant-lpt-modal" role="dialog">
      <h2 class="nest-resume-personal-name"> 示例候选人 </h2>
      <section>动物实验经验；是否操作过 tMCAO 尚未说明。</section>
    </div>
  `)
  const expected = { name: '示例候选人', text: '示例候选人 动物实验经验；是否操作过 tMCAO 尚未说明。' }
  const result = extractOpenLiepinResume(document)
  assert.deepEqual(result, expected)
  const inPage = new Function('document', `return (${extractOpenLiepinResume.toString()})(document)`)
  assert.deepEqual(inPage(document), expected)
  assert.deepEqual(parseOpenResume(result), expected)
  assert.equal(result.text.includes('页面背景'), false)
})

test('resume extraction fails closed when the modal is absent or ambiguous', () => {
  const { document: absent } = parseHTML('<div>没有打开简历详情</div>')
  assert.equal(extractOpenLiepinResume(absent), null)
  const { document: ambiguous } = parseHTML(`
    <div class="ant-lpt-modal">第一份足够长的简历详情文本</div>
    <div class="ant-lpt-modal">第二份足够长的简历详情文本</div>
  `)
  assert.equal(extractOpenLiepinResume(ambiguous), null)
  assert.throws(() => parseOpenResume(null))
  assert.throws(() => parseOpenResume({ name: '候选人', text: '过短' }))
})
