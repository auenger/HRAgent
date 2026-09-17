import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { animateBossGreeting } from '../dist/main/adapters/boss-greeting.js'

function page(button = '<button class="btn btn-greet">打招呼</button>') {
  const { document, HTMLElement } = parseHTML(`<div class="card-list"><article class="candidate-card-wrap"><b class="name">顾清扬</b><div class="base-info join-text-wrap">8年经验 Java</div><div class="content">支付平台</div>${button}</article></div>`)
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value() { return { x: 10, y: 20, width: 120, height: 32, top: 20, left: 10, right: 130, bottom: 52, toJSON() {} } } })
  return document
}

const candidate = { platform: 'boss', cardIndex: 0, name: '顾清扬', skills: '8年经验 Java', summary: '支付平台' }

test('BOSS greeting re-matches the exact card and visibly clicks one greet button', async () => {
  const document = page()
  let clicks = 0, visuals = 0
  document.querySelector('.btn-greet').addEventListener('click', () => { clicks++ })
  const result = await animateBossGreeting(document, candidate, 0, null, async () => { visuals++; return { point: { x: 15, y: 25 } } })
  assert.equal(result.greeted, true)
  assert.equal(result.alreadyContacted, false)
  assert.equal(clicks, 1)
  assert.equal(visuals, 1)
  assert.deepEqual(result.pointer, { x: 15, y: 25 })
})

test('BOSS greeting refuses stale cards and does not click', async () => {
  const document = page()
  let clicks = 0
  document.querySelector('.btn-greet').addEventListener('click', () => { clicks++ })
  const result = await animateBossGreeting(document, { ...candidate, summary: '不同页面内容' }, 0, null)
  assert.equal(result.greeted, false)
  assert.equal(clicks, 0)
})

test('BOSS greeting treats continue-contact as already contacted', async () => {
  const document = page('<button class="btn btn-continue btn-outline">继续沟通</button>')
  const result = await animateBossGreeting(document, candidate, 0, null)
  assert.equal(result.greeted, false)
  assert.equal(result.alreadyContacted, true)
})
