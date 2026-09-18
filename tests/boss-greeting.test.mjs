import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { inspectBossGreetingTarget, resolveBossGreetingTarget } from '../dist/main/adapters/boss-greeting.js'

function page(button = '<button class="btn btn-greet">打招呼</button>') {
  const { document, HTMLElement } = parseHTML(`<div class="card-list"><article class="candidate-card-wrap"><b class="name">顾清扬</b><div class="base-info join-text-wrap">8年经验 Java</div><div class="content">支付平台</div>${button}</article></div>`)
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value() { return { x: 10, y: 20, width: 120, height: 32, top: 20, left: 10, right: 130, bottom: 52, toJSON() {} } } })
  return document
}

const candidate = { platform: 'boss', cardIndex: 0, name: '顾清扬', skills: '8年经验 Java', summary: '支付平台' }

test('BOSS greeting resolver re-matches the exact card without clicking', () => {
  const document = page()
  assert.equal(inspectBossGreetingTarget(document, candidate), 'ready')
  assert.equal(resolveBossGreetingTarget(document, candidate), document.querySelector('.btn-greet'))
})

test('BOSS greeting resolver refuses stale cards', () => {
  const document = page()
  assert.equal(inspectBossGreetingTarget(document, { ...candidate, summary: '不同页面内容' }), 'unavailable')
  assert.equal(resolveBossGreetingTarget(document, { ...candidate, summary: '不同页面内容' }), null)
})

test('BOSS greeting treats continue-contact as already contacted', () => {
  const document = page('<button class="btn btn-continue btn-outline">继续沟通</button>')
  assert.equal(inspectBossGreetingTarget(document, candidate), 'already_contacted')
  assert.equal(resolveBossGreetingTarget(document, candidate), null)
})
