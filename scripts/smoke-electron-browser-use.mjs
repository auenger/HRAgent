import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView } from 'electron'
import { actOnBrowserFrame, inspectBrowserFrame } from '../dist/main/adapters/browser-use.js'

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, width: 900, height: 650 })
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 650 })
  const html = `<html><head><title>模拟搜索页</title></head><body>
    <form id="search"><input type="search" placeholder="搜索人才"><button>搜索</button></form>
    <button>立即沟通</button><div id="results">尚未搜索</div>
    <script>document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); document.querySelector('#results').textContent = '结果：' + document.querySelector('input').value
    })</script>
  </body></html>`
  try {
    await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const read = () => view.webContents.executeJavaScript(`(${inspectBrowserFrame.toString()})(document, 'main')`)
    const first = await read()
    assert.deepEqual(first.controls.map(control => control.kind), ['search_input', 'button'])
    const search = first.controls[0]
    const act = (action, signature) => view.webContents.executeJavaScript(`(() => {
      const inspectBrowserFrame = ${inspectBrowserFrame.toString()};
      return (${actOnBrowserFrame.toString()})(document, ${JSON.stringify(action)}, ${JSON.stringify(signature)}, 0)
    })()`)
    assert.equal((await act({ type: 'fill', ref: search.ref, value: 'Java 工程师' }, search.signature)).done, true)
    const second = await read()
    assert.equal((await act({ type: 'press_enter', ref: second.controls[0].ref }, second.controls[0].signature)).done, true)
    window.focus()
    view.webContents.focus()
    assert.equal(window.isFocused(), true)
    const before = await view.webContents.executeJavaScript('({ active: document.activeElement?.tagName, focused: document.hasFocus() })')
    view.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' })
    view.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await new Promise(resolve => setTimeout(resolve, 150))
    const results = await view.webContents.executeJavaScript('document.querySelector("#results").textContent')
    if (results !== '结果：Java 工程师') process.stderr.write(`Input focus before Enter: ${JSON.stringify(before)}; webContents focused: ${view.webContents.isFocused()}\n`)
    assert.equal(results, '结果：Java 工程师')
    process.stdout.write('Offline Electron browser-use search input and Enter verified.\n')
  } finally {
    view.webContents.close()
    window.close()
    app.quit()
  }
}).catch(error => { console.error(error); app.exit(1) })
