import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { actOnBrowserFrame, inspectBrowserFrame } from '../dist/main/adapters/browser-use.js'

test('search result snapshot works outside recommend and excludes contact controls', async () => {
  const { document } = parseHTML(`<html><head><title>搜索 Java 工程师</title></head><body>
    <input id="searchKeyword" placeholder="搜索职位或人才" type="text">
    <button>搜索</button><button>立即沟通</button>
    <input placeholder="发送消息" type="text"><input type="password" placeholder="登录密码">
    <section>Java 工程师 · Spring Boot · 5 年经验</section>
  </body></html>`)
  const snapshot = inspectBrowserFrame(document, 'main')
  assert.match(snapshot.text, /Java 工程师/u)
  assert.deepEqual(snapshot.controls.map(control => control.kind), ['search_input', 'button'])
  assert.equal(snapshot.controls[0].label, '搜索职位或人才')
  const input = snapshot.controls[0]
  const filled = await actOnBrowserFrame(document, { type: 'fill', ref: input.ref, value: 'Java 工程师' }, input.signature, 0)
  assert.equal(filled.done, true)
  assert.equal(filled.action, 'fill')
  assert.ok(filled.pointer)
  assert.equal(document.querySelector('#searchKeyword').value, 'Java 工程师')
  const pointer = document.querySelector('[data-agenthr-visual="pointer"]')
  assert.ok(pointer)
  assert.match(pointer.style.filter, /drop-shadow/u)
  assert.equal(document.querySelectorAll('[data-agenthr-visual="border"]').length, 0)
  const next = inspectBrowserFrame(document, 'main').controls.find(control => control.label === '搜索')
  const clicked = await actOnBrowserFrame(document, { type: 'click', ref: next.ref }, next.signature, 0, filled.pointer)
  assert.equal(clicked.done, true)
  assert.equal(document.querySelector('[data-agenthr-visual="pointer"]'), pointer)
  assert.equal(document.querySelectorAll('[data-agenthr-visual="border"]').length, 0)
})

test('browser action stops when a search control changes after snapshot', async () => {
  const { document } = parseHTML('<input placeholder="搜索人才" type="search"><button>搜索</button>')
  const control = inspectBrowserFrame(document, 'main').controls[0]
  document.querySelector('input').setAttribute('placeholder', '发送消息')
  const result = await actOnBrowserFrame(document, { type: 'fill', ref: control.ref, value: 'Java' }, control.signature, 0)
  assert.deepEqual(result, { done: false, action: 'stale_reference' })
  assert.equal(document.querySelector('input').value, '')
})
