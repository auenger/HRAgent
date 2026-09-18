import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { resolveCandidateDetailTarget } from '../dist/main/adapters/candidate-action.js'

test('candidate detail resolver returns only the re-matched detail region without clicking', () => {
  const { document } = parseHTML(`<main><article data-tlg-elem-id="b_pc_home_hp_res_listcard">
    <div class="newResumeLeft--abc"><span class="nest-resume-personal-name">模拟候选人</span>
      <span class="nest-resume-personal-skills">动物实验</span><p class="resume-description">CNS 研发</p></div>
    <button data-tlg-elem-id="chat_btn">沟通</button>
  </article></main>`)
  const candidate = { platform: 'liepin', cardIndex: 0, name: '模拟候选人', skills: '动物实验', summary: 'CNS 研发' }
  assert.equal(resolveCandidateDetailTarget(document, candidate), document.querySelector('.newResumeLeft--abc'))
  assert.equal(resolveCandidateDetailTarget(document, { ...candidate, skills: 'tMCAO' }), null)
  assert.equal(document.querySelectorAll('[data-agenthr-visual="pointer"]').length, 0)
})

test('candidate detail resolver refuses a card without a known detail target', () => {
  const { document } = parseHTML(`<div class="card-list"><article class="candidate-card-wrap">
    <strong class="name">模拟候选人</strong><span class="geek-info-detail">动物实验</span>
    <p class="content">CNS 研发</p><button class="btn-greet">沟通</button>
  </article></div>`)
  const result = resolveCandidateDetailTarget(document, {
    platform: 'boss', cardIndex: 0, name: '模拟候选人', skills: '动物实验', summary: 'CNS 研发',
  })
  assert.equal(result, null)
})
