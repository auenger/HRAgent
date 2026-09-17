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

test('Liepin search-page resume drawer is readable without a recommendation route assumption', () => {
  const { document } = parseHTML(`
    <main><p>搜索结果列表背景</p></main>
    <aside class="resume-detail-drawer">
      <h2 class="user-name">顾**</h2>
      <section>求职意向：苏州 生信工程师</section>
      <section>工作经历：五年生物信息分析经验，使用 Python 与 R。</section>
      <section>项目经历：负责 RNA-seq 质量控制、序列比对和差异分析。</section>
      <section>教育经历：生物信息学硕士。</section>
    </aside>
  `)
  const result = extractOpenLiepinResume(document)
  assert.equal(result.name, '顾**')
  assert.match(result.text, /RNA-seq/)
  assert.equal(result.text.includes('搜索结果列表背景'), false)
})

test('Liepin search detail recovers the displayed name next to the activity marker', () => {
  const { document } = parseHTML(`
    <aside class="resume-detail-panel">
      <div>中文</div><div>EN</div><div>快速定位：</div><div>生物信息</div><div>(12)</div>
      <div>查看大图</div><div>刘聪</div><div>3天内活跃</div><div>更新简历时间：2026.07.17</div>
      <section>求职意向：苏州 生物信息工程师</section>
      <section>工作经历：十年生物信息分析经验。</section>
      <section>项目经历：负责 RNA-seq 和 WES 分析。</section>
      <section>教育经历：武汉大学微生物学硕士。</section>
    </aside>
  `)
  assert.equal(extractOpenLiepinResume(document).name, '刘聪')
})
