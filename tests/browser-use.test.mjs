import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { actOnBrowserFrame, inspectBrowserFrame } from '../dist/main/adapters/browser-use.js'
import { setBrowserControlShield } from '../dist/main/adapters/browser-control.js'

test('browser control shield blocks manual pointer input only while Agent owns the page', () => {
  const { document } = parseHTML('<main><button>候选人详情</button></main>')
  assert.equal(setBrowserControlShield(document, false), true)
  assert.equal(document.querySelectorAll('[data-agenthr-control-shield]').length, 1)
  assert.equal(setBrowserControlShield(document, false), true)
  assert.equal(document.querySelectorAll('[data-agenthr-control-shield]').length, 1)
  assert.equal(setBrowserControlShield(document, true), false)
  assert.equal(document.querySelector('[data-agenthr-control-shield]'), null)
})

test('page snapshot exposes general controls and marks sensitive controls instead of hiding them', async () => {
  const { document } = parseHTML(`<html><head><title>搜索 Java 工程师</title></head><body>
    <input id="searchKeyword" placeholder="搜索职位或人才" type="text">
    <textarea aria-label="备注"></textarea>
    <select aria-label="城市"><option value="sh">上海</option><option value="hz">杭州</option></select>
    <input type="checkbox" aria-label="仅看在线"><button>展开更多条件</button><button>立即沟通</button>
    <div role="tab">推荐人才</div>
    <input placeholder="发送消息" type="text"><input type="password" placeholder="登录密码">
    <section>Java 工程师 · Spring Boot · 5 年经验</section>
  </body></html>`)
  const snapshot = inspectBrowserFrame(document, 'main')
  assert.match(snapshot.text, /Java 工程师/u)
  assert.deepEqual(snapshot.controls.map(control => control.kind), [
    'text_input', 'text_input', 'select', 'checkbox', 'button', 'button', 'tab', 'text_input', 'text_input',
  ])
  assert.equal(snapshot.controls[0].label, '搜索职位或人才')
  assert.equal(snapshot.controls.find(control => control.label === '展开更多条件').blockedReason, undefined)
  assert.match(snapshot.controls.find(control => control.label === '立即沟通').blockedReason, /授权/u)
  assert.match(snapshot.controls.find(control => control.label === '发送消息').blockedReason, /授权/u)
  assert.match(snapshot.controls.find(control => control.label === '登录密码').blockedReason, /人工输入/u)
  const input = snapshot.controls[0]
  const filled = await actOnBrowserFrame(document, { type: 'fill', ref: input.ref, value: 'Java 工程师' }, input.signature, 0)
  assert.equal(filled.done, true)
  assert.equal(filled.action, 'fill')
  assert.ok(filled.pointer)
  assert.equal(document.querySelector('#searchKeyword').value, 'Java 工程师')
  const pointer = document.querySelector('[data-agenthr-visual="pointer"]')
  assert.ok(pointer)
  assert.match(pointer.style.filter, /drop-shadow/u)
  assert.equal(pointer.style.width, '20px')
  assert.match(pointer.innerHTML, /fill="#20242b"/u)
  assert.equal(document.querySelectorAll('[data-agenthr-visual="border"]').length, 0)
  const next = inspectBrowserFrame(document, 'main').controls.find(control => control.label === '展开更多条件')
  const clicked = await actOnBrowserFrame(document, { type: 'click', ref: next.ref }, next.signature, 0, filled.pointer)
  assert.equal(clicked.done, true)
  assert.equal(document.querySelector('[data-agenthr-visual="pointer"]'), pointer)
  assert.equal(document.querySelectorAll('[data-agenthr-visual="border"]').length, 0)
})

test('Agent can select filters and toggle ordinary controls while sensitive actions require authorization', async () => {
  const { document } = parseHTML(`<main>
    <select aria-label="工作城市"><option value="sh">上海</option><option value="hz">杭州</option></select>
    <input type="checkbox" aria-label="最近活跃">
    <button>查看更多</button><button>发送消息</button>
  </main>`)
  let snapshot = inspectBrowserFrame(document, 'main')
  const city = snapshot.controls.find(control => control.kind === 'select')
  assert.deepEqual(city.options, [{ value: 'sh', label: '上海' }, { value: 'hz', label: '杭州' }])
  assert.equal((await actOnBrowserFrame(document, { type: 'select', ref: city.ref, value: 'hz' }, city.signature, 0)).done, true)
  assert.equal(document.querySelector('select').value, 'hz')

  snapshot = inspectBrowserFrame(document, 'main')
  const checkbox = snapshot.controls.find(control => control.kind === 'checkbox')
  assert.equal((await actOnBrowserFrame(document, { type: 'click', ref: checkbox.ref }, checkbox.signature, 0)).done, true)
  const ordinary = snapshot.controls.find(control => control.label === '查看更多')
  assert.equal((await actOnBrowserFrame(document, { type: 'click', ref: ordinary.ref }, ordinary.signature, 0)).done, true)
  const send = snapshot.controls.find(control => control.label === '发送消息')
  assert.deepEqual(await actOnBrowserFrame(document, { type: 'click', ref: send.ref }, send.signature, 0), {
    done: false, action: 'authorization_required', reason: '对外联系或提交需要用户授权',
  })
})

test('custom dropdowns and tabs with accessibility semantics are exposed as controls', () => {
  const { document } = parseHTML(`<main>
    <div role="combobox" aria-haspopup="listbox" aria-expanded="false">城市（北京）</div>
    <div role="option" tabindex="0">上海</div>
    <div role="tab">匹配度优先</div>
    <div role="switch" aria-label="过滤近14天查看"></div>
  </main>`)
  const controls = inspectBrowserFrame(document, 'search').controls
  assert.deepEqual(controls.map(control => [control.kind, control.label]), [
    ['button', '城市（北京）'], ['option', '上海'], ['tab', '匹配度优先'], ['checkbox', '过滤近14天查看'],
  ])
})

test('browser action stops when a search control changes after snapshot', async () => {
  const { document } = parseHTML('<input placeholder="搜索人才" type="search"><button>搜索</button>')
  const control = inspectBrowserFrame(document, 'main').controls[0]
  document.querySelector('input').setAttribute('placeholder', '发送消息')
  const result = await actOnBrowserFrame(document, { type: 'fill', ref: control.ref, value: 'Java' }, control.signature, 0)
  assert.deepEqual(result, { done: false, action: 'stale_reference', reason: '页面元素已经变化' })
  assert.equal(document.querySelector('input').value, '')
})

test('top-layer tutorial controls survive the bounded snapshot ahead of background controls', () => {
  const background = Array.from({ length: 340 }, (_, index) => `<button>列表按钮 ${index}</button>`).join('')
  const { document, HTMLElement } = parseHTML(`<main>${background}</main><div role="tooltip"><button>我知道了</button></div>`)
  HTMLElement.prototype.getClientRects = () => [{ length: 1 }]
  const registry = { nodes: new Map(), ids: new WeakMap(), next: 0, extras: new Set(), names: new WeakMap(), blocked: new WeakMap() }
  const snapshot = inspectBrowserFrame(document, 'main', registry)
  assert.equal(snapshot.controls.length, 300)
  assert.equal(snapshot.controls[0].label, '我知道了')
})
