import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView } from 'electron'
import { actOnBrowserFrame, inspectBrowserFrame } from '../dist/main/adapters/browser-use.js'
import { beginBrowserVisual, markBrowserVisualDispatched, restoreBrowserPointer } from '../dist/main/adapters/browser-visual.js'

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
    await view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const centerPixel = async () => {
      const image = await view.webContents.capturePage()
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      const offset = (Math.floor(height * .7) * width + Math.floor(width * .5)) * 4
      return Array.from(bitmap.subarray(offset, offset + 4))
    }
    const beforeOverlay = await centerPixel()
    const visual = view.webContents.executeJavaScript(`(() => {
      const restoreBrowserPointer = ${restoreBrowserPointer.toString()};
      const beginBrowserVisual = ${beginBrowserVisual.toString()};
      return beginBrowserVisual(document, null, { x: 50, y: 50 }, 450).then(({ border }) => {
        border.remove();
        return { cursorWidth: document.querySelector('[data-agenthr-visual="pointer"]').style.width };
      });
    })()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(await centerPixel(), beforeOverlay, 'browser content must remain visible through the border overlay')
    assert.equal((await visual).cursorWidth, '20px')
    const read = () => view.webContents.executeJavaScript(`(${inspectBrowserFrame.toString()})(document, 'main')`)
    const first = await read()
    assert.deepEqual(first.controls.map(control => control.kind), ['text_input', 'button', 'button'])
    assert.match(first.controls.find(control => control.label === '立即沟通').blockedReason, /授权/u)
    const search = first.controls[0]
    const act = (action, signature) => view.webContents.executeJavaScript(`(() => {
      const restoreBrowserPointer = ${restoreBrowserPointer.toString()};
      const beginBrowserVisual = ${beginBrowserVisual.toString()};
      const markBrowserVisualDispatched = ${markBrowserVisualDispatched.toString()};
      const inspectBrowserFrame = ${inspectBrowserFrame.toString()};
      return (${actOnBrowserFrame.toString()})(document, ${JSON.stringify(action)}, ${JSON.stringify(signature)}, 0)
    })()`)
    assert.equal((await act({ type: 'fill', ref: search.ref, value: 'Java 工程师' }, search.signature)).done, true)
    const second = await read()
    assert.equal((await act({ type: 'press_enter', ref: second.controls[0].ref }, second.controls[0].signature)).done, true)
    assert.equal(await view.webContents.executeJavaScript('document.querySelectorAll("[data-agenthr-visual=pointer]").length'), 1)
    window.focus()
    view.webContents.focus()
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
