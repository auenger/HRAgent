import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { animateOpenCandidate } from '../dist/main/adapters/candidate-action.js'

test('candidate detail action clicks only the detail region and retains the glowing pointer', async () => {
  const { document } = parseHTML(`<main><article data-tlg-elem-id="b_pc_home_hp_res_listcard">
    <div class="newResumeLeft--abc"><span class="nest-resume-personal-name">模拟候选人</span>
      <span class="nest-resume-personal-skills">动物实验</span><p class="resume-description">CNS 研发</p></div>
    <button data-tlg-elem-id="chat_btn">沟通</button>
  </article></main>`)
  const clicked = []
  document.querySelector('.newResumeLeft--abc').click = () => clicked.push('detail')
  document.querySelector('button').click = () => clicked.push('chat')
  const candidate = { platform: 'liepin', cardIndex: 0, name: '模拟候选人', skills: '动物实验', summary: 'CNS 研发' }
  const result = await animateOpenCandidate(document, candidate, 0)
  assert.equal(result.opened, true)
  assert.equal(result.name, '模拟候选人')
  assert.ok(result.pointer)
  assert.deepEqual(clicked, ['detail'])
  assert.equal(document.querySelectorAll('[data-agenthr-visual="pointer"]').length, 1)
  assert.equal(document.querySelectorAll('[data-agenthr-visual="border"]').length, 0)
  assert.deepEqual(await animateOpenCandidate(document, { ...candidate, skills: 'tMCAO' }, 0), { opened: false, name: '' })
  assert.deepEqual(clicked, ['detail'])
})

test('candidate detail action refuses a card without a known detail target', async () => {
  const { document } = parseHTML(`<div class="card-list"><article class="candidate-card-wrap">
    <strong class="name">模拟候选人</strong><span class="geek-info-detail">动物实验</span>
    <p class="content">CNS 研发</p><button class="btn-greet">沟通</button>
  </article></div>`)
  const result = await animateOpenCandidate(document, {
    platform: 'boss', cardIndex: 0, name: '模拟候选人', skills: '动物实验', summary: 'CNS 研发',
  }, 0)
  assert.deepEqual(result, { opened: false, name: '' })
})
