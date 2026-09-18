import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, WebContentsView } from 'electron'
import { CdpBrowser } from '../dist/main/cdp-browser.js'
import { RecruitmentBrowser } from '../dist/main/recruitment-browser.js'
import { resolveCandidateDetailTarget } from '../dist/main/adapters/candidate-action.js'

const testHome = mkdtempSync(join(tmpdir(), 'agenthr-cdp-smoke-'))
app.setPath('userData', testHome)
app.once('quit', () => rmSync(testHome, { recursive: true, force: true }))

// Exercise real Chromium frames, layout, trusted input and event handlers, without recruitment data.
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.url === '/search') res.end(`<!doctype html><style>
    .action {cursor:pointer;padding:10px;display:inline-block} .newResumeLeft--fixture{display:block;padding:6px} #cities[hidden],#cities [hidden],#detail[hidden]{display:none}
    #detail{position:fixed;inset:0;background:white;z-index:10} iframe{width:90%;height:200px}
    </style><div id="city" class="action">城市（北京）</div>
    <div id="cities" hidden><span id="province" class="action">福建</span><span id="fuzhou" class="action" hidden>福州</span></div>
    <label for="keyword">人才关键词</label><input id="keyword"><span id="search" class="action">搜索</span>
    <p id="results">尚未搜索</p><article data-tlg-elem-id="b_pc_home_hp_res_listcard">
      <a id="candidate" class="newResumeLeft--fixture" aria-label="周** · 教育 SaaS 销售" href="javascript:;"><span class="nest-resume-personal-name">周**</span>
      <span class="nest-resume-personal-skills">教育 SaaS 销售</span><p class="resume-description">6 年经验</p></a></article>
    <button id="send">立即沟通</button><button id="download">下载简历</button>
    <div id="detail" hidden><span id="close" class="action resume-custom-close"></span><iframe id="resume"></iframe></div>
    <div id="shadow"></div><div id="plain">没有角色和样式的点击控件</div><script>
    window.trusted=[];
    const on=(id,fn)=>document.getElementById(id).addEventListener('click',e=>{window.trusted.push(e.isTrusted);fn(e)});
    on('city',()=>cities.hidden=false);on('province',()=>fuzhou.hidden=false);
    on('fuzhou',()=>{city.textContent='城市（福州）';cities.hidden=true});
    on('search',()=>results.textContent=city.textContent+' / '+keyword.value+' / 1 条结果');
    on('candidate',()=>{detail.hidden=false;resume.src='/web/frame/c-resume/1'});
    on('close',()=>detail.hidden=true);
    on('plain',()=>plain.textContent='普通 div 已点击');
    const root=shadow.attachShadow({mode:'open'});root.innerHTML='<button>影子树控件</button>';
    </script>`)
  else if (req.url?.startsWith('/web/frame/c-resume/')) res.end('<html><body><section id="resume"><h1 class="name">测试候选人</h1><p>教育 SaaS 销售经验 6 年，负责客户开发与产品演示。</p></section></body></html>')
  else if (req.url === '/hidden') res.end('<button>隐藏的福州推荐候选人</button>')
  else res.end(`<!doctype html><body style="margin:0"><iframe name="recommendFrame" style="display:none" src="/hidden"></iframe><iframe name="searchFrame" style="margin:35px;width:750px;height:500px" src="http://localhost:${server.address().port}/search"></iframe></body>`)
})

async function run() {
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
const window = new BrowserWindow({ show: true, width: 950, height: 700 })
const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
window.contentView.addChildView(view)
view.setBounds({ x: 0, y: 0, width: 940, height: 660 })
const origin = `http://127.0.0.1:${server.address().port}`
const cdp = new CdpBrowser(view.webContents, url => url.startsWith(origin) || url.startsWith(`http://localhost:${server.address().port}`))
try {
  process.stdout.write('CDP smoke: loading fixture\n')
  await view.webContents.loadURL(origin)
  let snapshot
  const read = async () => snapshot = await cdp.snapshot()
  const find = label => snapshot.frames.flatMap(frame => frame.controls).find(control => control.label === label)
  const act = async (label, action = 'click', value, wait) => {
    process.stdout.write(`CDP smoke: ${action} ${label}\n`)
    await read()
    const control = find(label)
    assert.ok(control, `missing ${label}: ${JSON.stringify(snapshot)}`)
    return cdp.act({ snapshotId: snapshot.snapshotId, ref: control.ref, action, value, wait })
  }
  if (!process.env.AGENTHR_CDP_APP_ONLY) {
  process.stdout.write('CDP smoke: initial snapshot\n')
  await read()
  assert.equal(snapshot.engine, 'cdp')
  assert.deepEqual(snapshot.warnings, [])
  assert.equal(snapshot.frames.some(frame => frame.frame === 'recommendFrame'), false)
  assert.ok(find('影子树控件'), JSON.stringify(snapshot))
  assert.ok(find('没有角色和样式的点击控件'))
  assert.ok(snapshot.frames.some(frame => frame.accessibility.nodes?.some(node => node.name === '人才关键词')))
  await act('没有角色和样式的点击控件')
  await act('城市（北京）')
  await read()
  assert.ok(snapshot.frames.some(frame => frame.accessibility.mode === 'diff'))
  await act('福建')
  await act('福州')
  const fillReceipt = await act('人才关键词', 'fill', '教育信息化', { type: 'control_value', ref: find('人才关键词')?.ref, value: '教育信息化', timeoutMs: 1500 })
  assert.equal(fillReceipt.verified, true)
  assert.equal(fillReceipt.receipt.wait.satisfied, true)
  await read()
  assert.equal(find('人才关键词').value, '教育信息化')
  const searchReceipt = await act('搜索', 'click', undefined, { type: 'text_contains', frame: 'searchFrame', value: '1 条结果', timeoutMs: 1500 })
  assert.equal(searchReceipt.verified, true)
  await read()
  assert.ok(snapshot.frames.some(frame => frame.text.includes('城市（福州） / 教育信息化 / 1 条结果')))
  const searchFrame = view.webContents.mainFrame.framesInSubtree.find(frame => frame.name === 'searchFrame')
  const stable = find('搜索')
  await searchFrame.executeJavaScript(`document.body.prepend(Object.assign(document.createElement('button'),{textContent:'新出现的按钮'}))`)
  await cdp.act({ snapshotId: snapshot.snapshotId, ref: stable.ref, action: 'click' })
  const resolvedClick = await cdp.clickResolvedTarget({
    action: 'open_candidate', label: '周** · 教育 SaaS 销售', visualDurationMs: 0,
    value: { platform: 'liepin', cardIndex: 0, name: '周**', skills: '教育 SaaS 销售', summary: '6 年经验' },
    resolver: resolveCandidateDetailTarget,
  })
  assert.equal(resolvedClick.receipt.dispatch.mechanism, 'cdp_input')
  assert.equal(resolvedClick.receipt.dispatch.trustedInput, true)
  assert.equal(resolvedClick.receipt.presentation.purpose, 'visualization_only')
  await new Promise(resolve => setTimeout(resolve, 150))
  await read()
  assert.ok(snapshot.frames.some(frame => frame.path.startsWith('/web/frame/c-resume/')))
  assert.match(await cdp.readVisibleDocument('/web/frame/c-resume/', 'doc => doc.body.innerText'), /销售经验 6 年/)
  await act('关闭')
  await read()
  assert.equal(snapshot.frames.some(frame => frame.path.startsWith('/web/frame/c-resume/')), false)
  await assert.rejects(act('立即沟通'), /授权/)
  await assert.rejects(act('下载简历'), /授权/)
  const trusted = await searchFrame.executeJavaScript('window.trusted')
  assert.ok(trusted.length >= 7)
  assert.ok(trusted.every(Boolean), 'CDP clicks must produce trusted events')
  await read()
  const stale = find('搜索')
  await searchFrame.executeJavaScript(`document.querySelector('#search').textContent='发送消息'`)
  await assert.rejects(cdp.act({ snapshotId: snapshot.snapshotId, ref: stale.ref, action: 'click' }), /stale_reference/)
  await act('人才关键词', 'fill', '')
  await read()
  assert.equal(find('人才关键词').value, '')
  const previousId = snapshot.snapshotId
  await view.webContents.loadURL(`${origin}/next`)
  await assert.rejects(cdp.act({ snapshotId: previousId, ref: stale.ref, action: 'click' }), /过期/)
  }
  window.contentView.removeChildView(view)
  const browser = new RecruitmentBrowser(window, 'boss', () => {})
  browser.setBounds({ x: 0, y: 0, width: 940, height: 660 })
  // Intercept this isolated test session's HTTPS traffic; no real BOSS request is made.
  await browser.view.webContents.session.protocol.handle('https', async request => {
    const page = await fetch(origin + new URL(request.url).pathname)
    const html = (await page.text()).replaceAll(`http://localhost:${server.address().port}`, 'https://www.zhipin.com')
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  })
  try {
    await browser.view.webContents.loadURL('https://www.zhipin.com/web/chat/search')
    await browser.setHumanControl(false)
    const diagnostic = await browser.captureDiagnosticScreenshot()
    assert.equal(diagnostic.mediaType, 'image/png')
    assert.match(diagnostic.digest, /^[a-f0-9]{64}$/u)
    assert.ok(diagnostic.bytes > 0)
    const browserAct = async (label, action = 'click', value, wait) => {
      const page = await browser.snapshotPage()
      const control = page.frames.flatMap(frame => frame.controls).find(item => item.label === label)
      assert.ok(control, `App control missing: ${label}`)
      const result = await browser.actOnPage({ snapshotId: page.snapshotId, ref: control.ref, action, value,
        ...(typeof wait === 'function' ? { wait: wait(control, page) } : wait ? { wait } : {}) })
      assert.equal(await browser.view.webContents.executeJavaScript('!!document.querySelector("[data-agenthr-control-shield]")'), true)
      return result
    }
    await browserAct('城市（北京）')
    await browserAct('福建')
    await browserAct('福州')
    assert.equal((await browserAct('人才关键词', 'fill', '教育 SaaS', control => ({ type: 'control_value', ref: control.ref, value: '教育 SaaS', timeoutMs: 1500 }))).verified, true)
    assert.equal((await browserAct('搜索', 'click', undefined, { type: 'text_contains', frame: 'searchFrame', value: '1 条结果', timeoutMs: 1500 })).verified, true)
    assert.ok((await browser.snapshotPage()).frames.some(frame => frame.text.includes('城市（福州） / 教育 SaaS / 1 条结果')))
    await browserAct('周** · 教育 SaaS 销售')
    await new Promise(resolve => setTimeout(resolve, 150))
    const resume = await browser.readOpenResume()
    assert.equal(resume.name, '测试候选人')
    assert.match(resume.sourceDigest, /^[a-f0-9]{64}$/u)
    await browserAct('关闭')
    await assert.rejects(browser.readOpenResume(), /可见.*简历/)
    await assert.rejects(browserAct('立即沟通'), /授权/)
    assert.equal(await browser.view.webContents.executeJavaScript('!!document.querySelector("[data-agenthr-control-shield]")'), true)
  } finally {
    browser.dispose()
  }
  process.stdout.write('CDP verified: cross-origin frames, hidden-frame filtering, cascader, trusted search input/click, stable refs, shadow DOM, resume open/read/close and authorization guards.\n')
} finally {
  cdp.dispose()
  view.webContents.close()
  window.close()
  server.close()
  app.quit()
}
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1) })
