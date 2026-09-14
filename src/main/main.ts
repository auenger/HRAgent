import { app, BrowserWindow, ipcMain, type Rectangle } from 'electron'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { RecruitmentBrowser, type RecruitmentPage, type BrowserStatus, type Platform } from './recruitment-browser.js'
import { DshHost, type DshStatus } from './dsh-host.js'
import { AgentHrBridge } from './bridge.js'
import { JobBriefStore, jobBriefDigest } from './job-brief.js'
import { AssessmentStore, type ReviewStatus } from './assessments.js'

const root = dirname(fileURLToPath(import.meta.url))
const offlineSmoke = process.env.AGENTHR_OFFLINE_SMOKE === '1'
if (offlineSmoke) {
  const home = process.env.AGENTHR_OFFLINE_HOME
  if (!home || !isAbsolute(home)) throw new Error('Offline smoke requires an absolute isolated user-data path')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  app.setPath('userData', home)
}
const PANEL_WIDTH = 408
const HEADER_HEIGHT = 76
let window: BrowserWindow | undefined
let browser: RecruitmentBrowser | undefined
let dsh: DshHost | undefined
let bridge: AgentHrBridge | undefined
let dshWindow: BrowserWindow | undefined
let jobBriefStore: JobBriefStore
let assessmentStore: AssessmentStore

function browserBounds(): Rectangle {
  const [width, height] = window?.getContentSize() ?? [1200, 800]
  return { x: PANEL_WIDTH, y: HEADER_HEIGHT, width: Math.max(0, width - PANEL_WIDTH), height: Math.max(0, height - HEADER_HEIGHT) }
}

function emitStatus(): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send('agenthr:status-changed', {
    browser: browser?.getStatus(),
    dsh: dsh?.getStatus(),
  })
}

function assertPage(value: unknown): asserts value is RecruitmentPage {
  if (value !== 'login' && value !== 'recommend' && value !== 'messages') throw new Error('Unknown recruitment page')
}

function assertPlatform(value: unknown): asserts value is Platform {
  if (value !== 'boss' && value !== 'liepin') throw new Error('Unknown recruitment platform')
}

async function selectPlatform(platform: Platform): Promise<void> {
  if (offlineSmoke) throw new Error('Offline smoke disables recruitment-site navigation')
  if (!window) return
  if (browser?.platform === platform) return
  browser?.dispose()
  browser = new RecruitmentBrowser(window, platform, (_status: BrowserStatus) => emitStatus())
  browser.setBounds(browserBounds())
  emitStatus()
  await browser.open('login')
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'AgentHR',
    backgroundColor: '#f4f2ed',
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('resize', () => browser?.setBounds(browserBounds()))
  window.on('closed', () => { browser?.dispose(); browser = undefined; window = undefined })
  await window.loadFile(join(root, '../renderer/index.html'))
  emitStatus()
  if (!offlineSmoke) void selectPlatform('liepin').catch(error => console.error('[recruitment browser]', error))
}

async function verifyOfflineWindow(): Promise<void> {
  if (!window) throw new Error('Offline smoke window missing')
  const result = await window.webContents.executeJavaScript(`(async () => {
    const status = await window.agenthr.getStatus()
    const jobs = await window.agenthr.listJobs()
    const cards = await window.agenthr.listAssessments('all')
    return { title: document.title, text: document.body.innerText,
      bridge: typeof window.agenthr.openDsh, browser: status.browser ?? null,
      jobCount: jobs.jobs.length, cardCount: cards.length }
  })()`, true) as { title: string; text: string; bridge: string; browser: unknown; jobCount: number; cardCount: number }
  if (result.bridge !== 'function' || result.browser !== null || result.jobCount !== 0 || result.cardCount !== 0
    || !result.text.includes('当前岗位条件') || !result.text.includes('分析队列')) {
    throw new Error('Offline renderer or preload bridge did not initialize as expected')
  }
  console.log('AGENTHR_OFFLINE_SMOKE_OK')
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  jobBriefStore = new JobBriefStore(app.getPath('userData'))
  assessmentStore = new AssessmentStore(app.getPath('userData'))
  bridge = new AgentHrBridge(
    () => browser?.getStatus(),
    () => browser?.listVisibleCandidates() ?? Promise.reject(new Error('Browser unavailable')),
    () => browser?.readOpenResume() ?? Promise.reject(new Error('Browser unavailable')),
    () => jobBriefStore.load(),
    async value => {
      const brief = jobBriefStore.load()
      const sourceBrowser = browser
      if (!brief || !sourceBrowser) throw new Error('岗位或招聘页面不可用')
      const resume = await sourceBrowser.readOpenResume()
      if (browser !== sourceBrowser) throw new Error('招聘平台已切换，请重新读取简历')
      return assessmentStore.save(value, resume, brief, sourceBrowser.platform)
    },
  )
  const address = await bridge.start()
  dsh = new DshHost(app.getPath('userData'), address, (_status: DshStatus) => emitStatus())
  ipcMain.handle('agenthr:status', () => ({ browser: browser?.getStatus(), dsh: dsh?.getStatus() }))
  ipcMain.handle('agenthr:select-platform', async (_event, platform: unknown) => {
    assertPlatform(platform)
    await selectPlatform(platform)
  })
  ipcMain.handle('agenthr:open-page', async (_event, page: unknown) => {
    if (offlineSmoke) throw new Error('Offline smoke disables recruitment-site navigation')
    assertPage(page)
    await browser?.open(page)
  })
  ipcMain.handle('agenthr:reload-page', () => offlineSmoke ? undefined : browser?.reload())
  ipcMain.handle('agenthr:list-visible-candidates', () => browser?.listVisibleCandidates() ?? [])
  ipcMain.handle('agenthr:read-open-resume', () => browser?.readOpenResume() ?? Promise.reject(new Error('Browser unavailable')))
  ipcMain.handle('agenthr:get-job-brief', () => jobBriefStore.load())
  ipcMain.handle('agenthr:list-jobs', () => jobBriefStore.list())
  ipcMain.handle('agenthr:save-job-brief', (_event, value: unknown) => jobBriefStore.save(value))
  ipcMain.handle('agenthr:create-job', (_event, value: unknown) => jobBriefStore.create(value))
  ipcMain.handle('agenthr:activate-job', (_event, id: unknown) => jobBriefStore.activate(id))
  ipcMain.handle('agenthr:clear-active-job', () => jobBriefStore.clearActive())
  ipcMain.handle('agenthr:list-assessments', (_event, scope: unknown = 'all') => {
    if (scope !== 'active' && scope !== 'all') throw new Error('分析队列筛选范围无效')
    if (scope === 'all') return assessmentStore.list()
    const brief = jobBriefStore.load()
    return brief ? assessmentStore.list(100, jobBriefDigest(brief)) : []
  })
  ipcMain.handle('agenthr:set-review-status', (_event, id: unknown, status: unknown) => {
    if (typeof id !== 'string' || id.length < 1 || id.length > 100) throw new Error('分析卡片标识无效')
    return assessmentStore.setReviewStatus(id, status as ReviewStatus)
  })
  ipcMain.handle('agenthr:open-dsh', async () => {
    const status = dsh?.getStatus()
    if (status?.phase !== 'ready' || !status.url) throw new Error('DSH Host 尚未启动')
    if (dshWindow && !dshWindow.isDestroyed()) { dshWindow.focus(); return }
    dshWindow = new BrowserWindow({
      width: 1100, height: 800, title: 'DSH · AgentHR',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    dshWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    dshWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== new URL(status.url!).origin) event.preventDefault()
    })
    await dshWindow.loadURL(status.url)
  })
  await createWindow()
  if (offlineSmoke) {
    try { await verifyOfflineWindow(); app.quit() }
    catch (error) { console.error('[offline smoke]', error); app.exit(1) }
  } else {
    void dsh.start().catch(error => console.error('[dsh]', error))
  }
})

app.on('before-quit', () => { dsh?.stop(); void bridge?.stop(); assessmentStore?.close() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!window) void createWindow() })
