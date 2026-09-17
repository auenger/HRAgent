import { app, BrowserWindow, WebContentsView, dialog, ipcMain, type Rectangle } from 'electron'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { RecruitmentBrowser, type RecruitmentPage, type BrowserStatus, type Platform } from './recruitment-browser.js'
import { DshHost, type DshStatus } from './dsh-host.js'
import { AgentHrBridge } from './bridge.js'
import { JobBriefStore, jobBriefDigest } from './job-brief.js'
import { AssessmentStore, type ReviewStatus } from './assessments.js'
import { RecruitmentStore, type CandidateStage, type TaskStatus } from './recruitment-store.js'
import { WorkspaceStore } from './workspace-store.js'

const root = dirname(fileURLToPath(import.meta.url))
const offlineSmoke = process.env.AGENTHR_OFFLINE_SMOKE === '1'
const offlineChatSmoke = offlineSmoke && process.env.AGENTHR_OFFLINE_CHAT_SMOKE === '1'
if (offlineSmoke) {
  const home = process.env.AGENTHR_OFFLINE_HOME
  if (!home || !isAbsolute(home)) throw new Error('Offline smoke requires an absolute isolated user-data path')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  app.setPath('userData', home)
}
let navWidth = 216
let expandedNavWidth = 216
let navCollapsed = false
let rightWidth = 520
const SHELL_CHROME_HEIGHT = 48
const SIDE_TOOLBAR_HEIGHT = 48
let window: BrowserWindow | undefined
let browser: RecruitmentBrowser | undefined
const browsers = new Map<Platform, RecruitmentBrowser>()
let dshView: WebContentsView | undefined
let dshViewUrl: string | undefined
let workspaceTab: 'chat' | 'workspace' = 'chat'
let browserMode: 'collapsed' | 'split' | 'fullscreen' = 'collapsed'
let rightTab: 'files' | 'browser' = 'browser'
let browserControl: 'agent' | 'human' = 'agent'
let dsh: DshHost | undefined
let bridge: AgentHrBridge | undefined
let dshWindow: BrowserWindow | undefined
let jobBriefStore: JobBriefStore
let assessmentStore: AssessmentStore
let recruitmentStore: RecruitmentStore
let localWorkspace: WorkspaceStore
let quitting = false
const appRunId = randomUUID()
let agentBrowserActionInFlight = false

function browserBounds(): Rectangle {
  const [width, height] = window?.getContentSize() ?? [1200, 800]
  if (browserMode === 'collapsed' || rightTab !== 'browser') return { x: width, y: SHELL_CHROME_HEIGHT, width: 0, height: 0 }
  const available = Math.max(0, width - navWidth)
  const browserWidth = browserMode === 'fullscreen' ? available : Math.min(Math.max(420, rightWidth), Math.max(0, available - 320))
  return {
    x: width - browserWidth,
    y: SHELL_CHROME_HEIGHT + SIDE_TOOLBAR_HEIGHT,
    width: browserWidth,
    height: Math.max(0, height - SHELL_CHROME_HEIGHT - SIDE_TOOLBAR_HEIGHT),
  }
}

function dshBounds(): Rectangle {
  const [width, height] = window?.getContentSize() ?? [1200, 800]
  const browserWidth = browserMode === 'split' ? Math.min(Math.max(420, rightWidth), Math.max(0, width - navWidth - 320)) : 0
  const visible = workspaceTab === 'chat' && browserMode !== 'fullscreen'
  const resizeGutter = browserMode === 'split' ? 8 : 0
  return visible
    ? { x: navWidth, y: SHELL_CHROME_HEIGHT, width: Math.max(0, width - navWidth - browserWidth - resizeGutter), height: Math.max(0, height - SHELL_CHROME_HEIGHT) }
    : { x: navWidth, y: SHELL_CHROME_HEIGHT, width: 0, height: 0 }
}

function syncViewBounds(): void {
  for (const candidate of browsers.values()) candidate.setBounds(candidate === browser ? browserBounds() : { x: 0, y: 0, width: 0, height: 0 })
  dshView?.setBounds(dshBounds())
}

function setBrowserMode(mode: 'collapsed' | 'split' | 'fullscreen'): void {
  browserMode = mode
  syncViewBounds()
  emitStatus()
}

function setRightTab(tab: 'files' | 'browser'): void {
  if (tab === 'files' && agentBrowserActionInFlight) throw new Error('Agent 正在操作浏览器，请等待动作结束后切换文件')
  rightTab = tab
  if (browserMode === 'collapsed') browserMode = 'split'
  syncViewBounds()
  emitStatus()
}

function assertAgentBrowserControl(): void {
  if (browserControl !== 'agent') throw new Error('浏览器正由你接管，请先将控制权交还 Agent')
}

async function runAgentBrowserAction<T>(action: () => Promise<T>): Promise<T> {
  assertAgentBrowserControl()
  if (agentBrowserActionInFlight) throw new Error('上一个 Agent 页面动作尚未结束')
  agentBrowserActionInFlight = true
  try { return await action() }
  finally { agentBrowserActionInFlight = false }
}

function withValidatedWorkspacePaths(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const input = value as Record<string, unknown>
  if (input.workspacePaths === undefined) return value
  if (!Array.isArray(input.workspacePaths) || input.workspacePaths.length > 20) throw new Error('任务关联文件数量无效')
  const workspacePaths = input.workspacePaths.map(path => {
    if (typeof path !== 'string') throw new Error('任务关联文件路径无效')
    const target = localWorkspace.resolveInside(path)
    if (!existsSync(target)) throw new Error(`任务关联文件不存在：${path}`)
    return path
  })
  return { ...input, workspacePaths }
}

function currentSafeBrowserUrl(): string | null {
  try {
    const parsed = new URL(browser?.getStatus().url ?? '')
    return `${parsed.origin}${parsed.pathname}`
  } catch { return null }
}

async function insertTaskPrompt(taskId: string, newSession: boolean): Promise<void> {
  if (!dshView || dsh?.getStatus().phase !== 'ready') throw new Error('Agent 对话尚未就绪')
  if (newSession) {
    const opened: unknown = await dshView.webContents.executeJavaScript(`(() => {
      if (Array.from(document.querySelectorAll('h2')).some(el => el.textContent?.includes('Internal Testing Notice'))) return false
      const button = Array.from(document.querySelectorAll('button')).find(el => /new session|新会话/iu.test(el.textContent ?? '') || /new session|新会话/iu.test(el.getAttribute('aria-label') ?? ''))
      if (!button) return false
      button.click()
      return true
    })()`)
    if (opened !== true) throw new Error('请先确认 DSH 的首次使用提示')
  }
  const deadline = Date.now() + 5000
  let focused = false
  while (Date.now() < deadline && !focused) {
    focused = await dshView.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[data-composer-input][contenteditable="true"]')
      if (!input) return false
      input.focus()
      return true
    })()`) as boolean
    if (!focused) await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  if (!focused) throw new Error('Agent 对话输入框尚未就绪')
  workspaceTab = 'chat'
  syncViewBounds()
  dshView.webContents.focus()
  const instruction = `请${newSession ? '在这个新对话中分析' : '继续执行'} AgentHR 任务 ${taskId}。先调用 agenthr_get_task 读取原始输入、关联文件和已有结果；按任务需要操作浏览器。每得到一组可复核结论，就调用 agenthr_append_task_result 写回该任务。发送消息、打招呼、下载或写文件仍需遵守用户授权。`
  await dshView.webContents.insertText(instruction)
  dshView.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' })
  dshView.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' })
  dshView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}

function closeDshView(): void {
  if (!dshView) return
  if (window && !window.isDestroyed()) window.contentView.removeChildView(dshView)
  dshView.webContents.close()
  dshView = undefined
  dshViewUrl = undefined
}

async function syncDshView(status: DshStatus): Promise<void> {
  if (!window || window.isDestroyed() || (offlineSmoke && !offlineChatSmoke)) return
  if (status.phase !== 'ready' || !status.url) { closeDshView(); return }
  if (dshView && dshViewUrl === status.url) { dshView.setBounds(dshBounds()); return }
  closeDshView()
  const allowedOrigin = new URL(status.url).origin
  const view = new WebContentsView({ webPreferences: {
    partition: 'persist:agenthr-dsh', nodeIntegration: false, contextIsolation: true, sandbox: true,
  } })
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault()
  })
  window.contentView.addChildView(view)
  dshView = view
  dshViewUrl = status.url
  view.setBounds(dshBounds())
  await view.webContents.loadURL(status.url)
}

function emitStatus(): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send('agenthr:status-changed', {
    browser: browser ? { ...browser.getStatus(), active: true } : undefined,
    dsh: dsh?.getStatus(),
    workspace: localWorkspace?.get(),
    shell: { browserMode, rightTab, browserControl, workspaceTab, navWidth, navCollapsed, rightWidth },
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
  rightTab = 'browser'
  if (browser?.platform === platform) { syncViewBounds(); emitStatus(); return }
  let selected = browsers.get(platform)
  const created = !selected
  if (!selected) {
    selected = new RecruitmentBrowser(
      window,
      platform,
      (_status: BrowserStatus) => { if (browser?.platform === platform) emitStatus() },
      async (fileName, sourceUrl) => {
        if (!window || window.isDestroyed()) return null
        const decision = await dialog.showMessageBox(window, {
          type: 'question',
          title: '确认下载候选人附件',
          message: `是否下载“${fileName}”？`,
          detail: `确认后将保存到工作目录的 downloads/${platform}/。\n来源：${sourceUrl}`,
          buttons: ['取消', '下载'],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        })
        return decision.response === 1 ? localWorkspace.createDownloadTarget(platform, fileName) : null
      },
      () => window?.webContents.send('agenthr:workspace-changed'),
    )
    browsers.set(platform, selected)
  }
  browser = selected
  await browser.setHumanControl(browserControl === 'human')
  syncViewBounds()
  emitStatus()
  if (created) await browser.open('login')
}

async function captureVisibleCandidates() {
  const sourceBrowser = browser
  if (!sourceBrowser) throw new Error('招聘页面不可用')
  const candidates = await sourceBrowser.listVisibleCandidates()
  if (browser !== sourceBrowser) throw new Error('招聘平台已切换，请重新读取候选人')
  const jobId = jobBriefStore.list().activeId
  const records = recruitmentStore.captureVisible(candidates, sourceBrowser.platform, sourceBrowser.getStatus().url, jobId)
  window?.webContents.send('agenthr:candidates-changed')
  return { candidates, records }
}

async function greetQualifiedBossCandidate(value: unknown) {
  if (typeof value !== 'object' || value === null) throw new Error('打招呼请求无效')
  const input = value as Record<string, unknown>
  if (input.confirmed !== true || typeof input.assessmentId !== 'string' || typeof input.fingerprint !== 'string') {
    throw new Error('自动打招呼需要招聘人员明确确认，并提供分析记录与候选人标识')
  }
  const fingerprint = input.fingerprint
  if (offlineSmoke) throw new Error('离线模式不能向候选人打招呼')
  const activeJob = jobBriefStore.loadRecord()
  if (!activeJob) throw new Error('请先选择当前岗位')
  const assessment = assessmentStore.get(input.assessmentId)
  if (assessment.platform !== 'boss') throw new Error('自动打招呼当前仅支持 BOSS 直聘')
  if (assessment.jobBriefDigest !== jobBriefDigest(activeJob)) throw new Error('岗位条件已变化，请重新分析候选人')
  if (assessment.reviewStatus !== 'reviewed') throw new Error('分析结果需要先由招聘人员复核')
  if (assessment.findings.length === 0 || assessment.findings.some(finding => finding.verdict === 'unknown' || finding.verdict === 'explicit_mismatch')) {
    throw new Error('候选人仍有未知或不符合的岗位条件，不能自动打招呼')
  }
  const prior = recruitmentStore.getGreetingForAssessment(assessment.id)
    ?? recruitmentStore.findGreeting(activeJob.id, assessment.sourceDigest)
  if (prior) return prior
  return runAgentBrowserAction(async () => {
    const duplicate = recruitmentStore.getGreetingForAssessment(assessment.id)
      ?? recruitmentStore.findGreeting(activeJob.id, assessment.sourceDigest)
    if (duplicate) return duplicate
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (recruitmentStore.countGreetedSince(activeJob.id, today.toISOString()) >= 20) {
      throw new Error('当前岗位今天已主动打招呼 20 人，请明天继续或改为人工联系')
    }
    const sourceBrowser = browser
    if (!sourceBrowser || sourceBrowser.platform !== 'boss') throw new Error('请先打开 BOSS 直聘推荐页')
    setRightTab('browser')
    setBrowserMode('split')
    const visible = await sourceBrowser.listVisibleCandidates()
    const candidate = visible.find(item => item.fingerprint === fingerprint)
    if (!candidate || candidate.name.replace(/\s+/gu, '') !== assessment.candidateName.replace(/\s+/gu, '')) {
      throw new Error('当前候选人卡片与复核记录不一致，请重新读取和分析')
    }
    const result = await sourceBrowser.greetBossCandidate(fingerprint)
    if (browser !== sourceBrowser) throw new Error('招聘平台已切换，打招呼结果未记录')
    const record = recruitmentStore.recordGreeting({ assessmentId: assessment.id, jobId: activeJob.id,
      candidateName: assessment.candidateName, sourceDigest: assessment.sourceDigest,
      result: result.alreadyContacted ? 'already_contacted' : 'greeted' })
    window?.webContents.send('agenthr:records-changed')
    return record
  })
}

async function validatePlatform(check: 'candidate_list' | 'resume_detail') {
  const sourceBrowser = browser
  if (!sourceBrowser) throw new Error('招聘页面不可用')
  const platform = sourceBrowser.platform
  try {
    let summary: string
    if (check === 'candidate_list') {
      const candidates = await sourceBrowser.listVisibleCandidates()
      if (candidates.length === 0) throw new Error('当前推荐页没有可验证的候选人卡片')
      summary = `候选人列表读取成功，共 ${candidates.length} 条可见线索。`
    }
    else { await sourceBrowser.readOpenResume(); summary = '当前候选人简历详情读取成功。' }
    if (browser !== sourceBrowser) throw new Error('招聘平台已切换，请重新验证')
    return recruitmentStore.recordPlatformValidation(platform, check, 'passed', summary, appRunId)
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error)
    return recruitmentStore.recordPlatformValidation(platform, check, 'failed', summary, appRunId)
  }
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1540, height: 920, minWidth: 1100, minHeight: 650,
    title: 'AgentHR',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
  window.on('resize', () => { syncViewBounds(); emitStatus() })
  window.on('closed', () => { for (const candidate of browsers.values()) candidate.dispose(); browsers.clear(); browser = undefined; closeDshView(); window = undefined })
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
    const validations = await window.agenthr.listPlatformValidations()
    await window.agenthr.setBrowserMode('split')
    await new Promise(resolve => setTimeout(resolve, 50))
    const splitStatus = await window.agenthr.getStatus()
    const browserToolbarButtons = Array.from(document.querySelectorAll('.browser-toolbar button'))
    const browserIconTooltips = browserToolbarButtons.length > 0
      && browserToolbarButtons.every(button => button.getAttribute('data-tooltip')?.trim())
      && browserToolbarButtons.some(button => button.classList.contains('platform-switch'))
    await window.agenthr.setBrowserControl('human')
    const humanStatus = await window.agenthr.getStatus()
    await window.agenthr.setBrowserControl('agent')
    await window.agenthr.setBrowserMode('collapsed')
    await window.agenthr.setRightTab('files')
    const filesStatus = await window.agenthr.getStatus()
    await window.agenthr.setPaneLayout({ navWidth: 250, rightWidth: 600 })
    const resizedStatus = await window.agenthr.getStatus()
    await window.agenthr.setPaneLayout({ navCollapsed: true })
    const collapsedNavStatus = await window.agenthr.getStatus()
    await window.agenthr.setPaneLayout({ navCollapsed: false, navWidth: 216, rightWidth: 520 })
    await window.agenthr.setRightTab('browser')
    await window.agenthr.setBrowserMode('collapsed')
    return { title: document.title, text: document.body.innerText,
      bridge: typeof window.agenthr.openDsh, restartBridge: typeof window.agenthr.restartDsh,
      tabBridge: typeof window.agenthr.setWorkspaceTab, promptBridge: typeof window.agenthr.insertDshPrompt,
      browserModeBridge: typeof window.agenthr.setBrowserMode, browserControlBridge: typeof window.agenthr.setBrowserControl,
      rightTabBridge: typeof window.agenthr.setRightTab, paneLayoutBridge: typeof window.agenthr.setPaneLayout, fileBridge: typeof window.agenthr.pickFiles, sessionBridge: typeof window.agenthr.newDshSession,
      validationBridge: typeof window.agenthr.validatePlatform,
      browser: status.browser ?? null, shell: status.shell,
      splitMode: splitStatus.shell?.browserMode, humanControl: humanStatus.shell?.browserControl,
      browserIconTooltips,
      filesTab: filesStatus.shell?.rightTab, navWidth: resizedStatus.shell?.navWidth, rightWidth: resizedStatus.shell?.rightWidth, collapsedNav: collapsedNavStatus.shell?.navCollapsed,
      jobCount: jobs.jobs.length, cardCount: cards.length, validationCount: validations.length }
  })()`, true) as { title: string; text: string; bridge: string; restartBridge: string; tabBridge: string; promptBridge: string; browserModeBridge: string; browserControlBridge: string; rightTabBridge: string; paneLayoutBridge: string; fileBridge: string; sessionBridge: string; validationBridge: string; browser: unknown; shell: unknown; splitMode: string; humanControl: string; browserIconTooltips: boolean; filesTab: string; navWidth: number; rightWidth: number; collapsedNav: boolean; jobCount: number; cardCount: number; validationCount: number }
  if (result.bridge !== 'function' || result.restartBridge !== 'function' || result.tabBridge !== 'function' || result.promptBridge !== 'function'
    || result.browserModeBridge !== 'function' || result.browserControlBridge !== 'function' || result.validationBridge !== 'function'
    || result.rightTabBridge !== 'function' || result.paneLayoutBridge !== 'function' || result.fileBridge !== 'function' || result.sessionBridge !== 'function'
    || result.filesTab !== 'files' || result.navWidth !== 250 || result.rightWidth !== 600 || result.collapsedNav !== true
    || result.splitMode !== 'split' || result.humanControl !== 'human' || !result.browserIconTooltips
    || result.browser !== null || result.jobCount !== 0 || result.cardCount !== 0 || result.validationCount !== 0
    || !result.text.includes('AI 工作台') || !result.text.includes('岗位管理')) {
    throw new Error('Offline renderer or preload bridge did not initialize as expected')
  }
  const screenshot = await window.capturePage()
  writeFileSync(join(app.getPath('userData'), 'agenthr-shell-smoke.png'), screenshot.toPNG())
  navCollapsed = true
  navWidth = 64
  syncViewBounds()
  emitStatus()
  await new Promise(resolveWait => setTimeout(resolveWait, 80))
  writeFileSync(join(app.getPath('userData'), 'agenthr-nav-collapsed-smoke.png'), (await window.capturePage()).toPNG())
  navCollapsed = false
  navWidth = expandedNavWidth
  syncViewBounds()
  emitStatus()
  setRightTab('files')
  await new Promise(resolveWait => setTimeout(resolveWait, 80))
  writeFileSync(join(app.getPath('userData'), 'agenthr-files-smoke.png'), (await window.capturePage()).toPNG())
  setBrowserMode('collapsed')
  setRightTab('browser')
  setBrowserMode('collapsed')
  await window.webContents.executeJavaScript(`(async () => {
    const jobsButton = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('岗位管理'))
    jobsButton?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 80))
  })()`)
  writeFileSync(join(app.getPath('userData'), 'agenthr-jobs-smoke.png'), (await window.capturePage()).toPNG())
  setBrowserMode('split')
  await new Promise(resolveWait => setTimeout(resolveWait, 80))
  writeFileSync(join(app.getPath('userData'), 'agenthr-browser-drawer-smoke.png'), (await window.capturePage()).toPNG())
  setBrowserMode('collapsed')
  await window.webContents.executeJavaScript(`(async () => {
    const tasksButton = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('招聘任务'))
    tasksButton?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 80))
  })()`)
  writeFileSync(join(app.getPath('userData'), 'agenthr-tasks-smoke.png'), (await window.capturePage()).toPNG())
  await window.webContents.executeJavaScript(`(async () => {
    const accountsButton = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('平台账号'))
    accountsButton?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 80))
  })()`)
  writeFileSync(join(app.getPath('userData'), 'agenthr-accounts-smoke.png'), (await window.capturePage()).toPNG())
  const smokeJob = jobBriefStore.create({
    role: 'Java 后端工程师', requirements: '负责招聘平台核心服务开发。', criteria: ['熟悉 Java', '有微服务经验'],
    salaryRange: '30K-45K', location: '上海', employmentType: 'full_time', status: 'open', hiringTarget: 2,
  })
  const failedSmokeTask = recruitmentStore.createTask({ jobId: smokeJob.id, type: 'analyze', platform: 'liepin', title: '读取候选人简历', description: '读取当前打开的候选人简历并按岗位条件逐项分析。' })
  recruitmentStore.setTaskStatus(failedSmokeTask.id, 'failed', failedSmokeTask.updatedAt, { code: 'PAGE_CHANGED', message: '候选人详情已关闭，请重新打开后重试。' })
  const smokeCandidates = recruitmentStore.captureVisible([
    { cardIndex: 0, name: '林清禾', skills: 'Java · Spring Boot', summary: '电商平台研发', fingerprint: 'a'.repeat(64) },
  ], 'liepin', 'https://lpt.liepin.com/recommend', smokeJob.id)
  recruitmentStore.captureVisible([
    { cardIndex: 0, name: '林清禾（BOSS）', skills: 'Java · 微服务', summary: '平台服务研发', fingerprint: 'b'.repeat(64) },
  ], 'boss', 'https://www.zhipin.com/web/geek/recommend', smokeJob.id)
  await window.webContents.executeJavaScript(`(async () => {
    const tasksButton = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('招聘任务'))
    tasksButton?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  })()`)
  writeFileSync(join(app.getPath('userData'), 'agenthr-task-error-smoke.png'), (await window.capturePage()).toPNG())
  const talentResult = await window.webContents.executeJavaScript(`(async () => {
    const talentButton = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('人才库'))
    talentButton?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 120))
    const stageSelect = document.querySelector('.candidate-rows select')
    let stageBefore = ''
    let stageAfter = ''
    if (stageSelect instanceof HTMLSelectElement) {
      stageSelect.value = 'interview'
      stageSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolveWait => setTimeout(resolveWait, 40))
      stageBefore = (await window.agenthr.listCandidates('active')).find(candidate => candidate.displayName.includes('BOSS'))?.stage ?? ''
      const confirmStage = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('确认修改'))
      confirmStage?.click()
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
      stageAfter = (await window.agenthr.listCandidates('active')).find(candidate => candidate.displayName.includes('BOSS'))?.stage ?? ''
    }
    const mergeSelect = document.querySelector('select[aria-label="选择重复候选人"]')
    if (mergeSelect instanceof HTMLSelectElement && mergeSelect.options.length > 1) {
      mergeSelect.value = mergeSelect.options[1].value
      mergeSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolveWait => setTimeout(resolveWait, 40))
      const prepareButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('准备合并'))
      prepareButton?.click()
      await new Promise(resolveWait => setTimeout(resolveWait, 40))
    }
    let rejected = false
    try {
      await window.agenthr.mergeCandidates({ primaryId: '${smokeCandidates[0].id}', duplicateId: '${smokeCandidates[0].id}' })
    } catch (error) { rejected = String(error).includes('明确确认') }
    const content = document.querySelector('.content-scroll')
    if (content instanceof HTMLElement) content.scrollTop = content.scrollHeight
    return { text: document.body.innerText, candidateCount: (await window.agenthr.listCandidates('active')).length, rejected, stageBefore, stageAfter }
  })()`, true) as { text: string; candidateCount: number; rejected: boolean; stageBefore: string; stageAfter: string }
  if (talentResult.candidateCount !== 2 || !talentResult.rejected || talentResult.stageBefore !== 'lead' || talentResult.stageAfter !== 'interview'
    || !talentResult.text.includes('确认合并候选人')) {
    throw new Error('Talent workspace or merge confirmation guard did not initialize as expected')
  }
  writeFileSync(join(app.getPath('userData'), 'agenthr-talent-smoke.png'), (await window.capturePage()).toPNG())
  const jobPreview = await window.webContents.executeJavaScript(`(async () => {
    const jobsButton = Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('岗位管理'))
    jobsButton?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 120))
    const location = document.querySelector('#job-location')
    if (location instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(location, '杭州')
      location.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const preview = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('预览修改'))
    preview?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    return { text: document.body.innerText, location: (await window.agenthr.listJobs()).jobs.find(job => job.id === '${smokeJob.id}')?.location }
  })()`, true) as { text: string; location?: string }
  if (jobPreview.location !== '上海' || !jobPreview.text.includes('确认更新岗位条件')) throw new Error('Job change preview did not guard the update')
  writeFileSync(join(app.getPath('userData'), 'agenthr-job-confirm-smoke.png'), (await window.capturePage()).toPNG())
  const savedLocation = await window.webContents.executeJavaScript(`(async () => {
    const confirm = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('确认保存'))
    confirm?.click()
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    return (await window.agenthr.listJobs()).jobs.find(job => job.id === '${smokeJob.id}')?.location
  })()`, true)
  if (savedLocation !== '杭州') throw new Error('Confirmed job update was not persisted')
  console.log('AGENTHR_OFFLINE_SMOKE_OK')
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  jobBriefStore = new JobBriefStore(app.getPath('userData'))
  assessmentStore = new AssessmentStore(app.getPath('userData'))
  recruitmentStore = new RecruitmentStore(app.getPath('userData'))
  localWorkspace = new WorkspaceStore(app.getPath('userData'))
  bridge = new AgentHrBridge(
    () => browser ? { ...browser.getStatus(), active: true } : undefined,
    () => browser?.listVisibleCandidates() ?? Promise.reject(new Error('Browser unavailable')),
    () => browser?.readOpenResume() ?? Promise.reject(new Error('Browser unavailable')),
    () => jobBriefStore.loadRecord(),
    async value => {
      const brief = jobBriefStore.load()
      const sourceBrowser = browser
      if (!brief || !sourceBrowser) throw new Error('岗位或招聘页面不可用')
      const resume = await sourceBrowser.readOpenResume()
      if (browser !== sourceBrowser) throw new Error('招聘平台已切换，请重新读取简历')
      const card = assessmentStore.save(value, resume, brief, sourceBrowser.platform)
      recruitmentStore.captureResume(resume, sourceBrowser.platform, sourceBrowser.getStatus().url, jobBriefStore.list().activeId, card.id)
      window?.webContents.send('agenthr:candidates-changed')
      window?.webContents.send('agenthr:records-changed')
      return card
    },
    async value => {
      if (typeof value !== 'object' || value === null) throw new Error('岗位配置格式无效')
      const input = value as Record<string, unknown>
      const brief = {
        role: input.role, requirements: input.requirements, criteria: input.criteria,
        salaryRange: input.salaryRange, location: input.location, employmentType: input.employmentType,
        status: input.status, hiringTarget: input.hiringTarget,
      }
      const record = input.mode === 'create' ? jobBriefStore.create(brief)
        : input.mode === 'update_active' && typeof input.expectedUpdatedAt === 'string' ? jobBriefStore.save(brief, input.expectedUpdatedAt)
          : (() => { throw new Error('岗位保存模式无效') })()
      recruitmentStore.recordEvent(input.mode === 'create' ? 'job.created' : 'job.updated', 'job', record.id, `${input.mode === 'create' ? '创建' : '更新'}岗位：${record.role}`)
      window?.webContents.send('agenthr:jobs-changed')
      window?.webContents.send('agenthr:records-changed')
      return record
    },
    async platform => runAgentBrowserAction(async () => {
      setRightTab('browser')
      setBrowserMode('split')
      if (offlineSmoke) throw new Error('离线模式不能打开招聘网站')
      await selectPlatform(platform)
      if (!browser || browser.platform !== platform) throw new Error('招聘平台不可用')
      await browser.open('recommend')
      return { platform, page: 'recommend' }
    }),
    fingerprint => runAgentBrowserAction(async () => {
      setRightTab('browser')
      setBrowserMode('split')
      if (!browser) throw new Error('招聘页面不可用')
      return browser.openCandidatePreview(fingerprint)
    }),
    () => browser?.snapshotPage() ?? Promise.reject(new Error('招聘页面不可用')),
    value => runAgentBrowserAction(async () => {
      setRightTab('browser')
      setBrowserMode('split')
      if (!browser) throw new Error('招聘页面不可用')
      return browser.actOnPage(value)
    }),
    async () => recruitmentStore.listTasks(),
    async value => {
      const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      const jobId = input.jobId ?? jobBriefStore.list().activeId ?? null
      const task = recruitmentStore.createTask(withValidatedWorkspacePaths({ ...input, jobId }))
      window?.webContents.send('agenthr:tasks-changed')
      return task
    },
    async () => (await captureVisibleCandidates()).records,
    async () => {
      const jobId = jobBriefStore.list().activeId
      return jobId ? recruitmentStore.listCandidates(100, jobId) : []
    },
    async value => {
      if (typeof value !== 'object' || value === null) throw new Error('候选人资料格式无效')
      const input = value as Record<string, unknown>
      if (typeof input.candidateId !== 'string' || typeof input.expectedUpdatedAt !== 'string') throw new Error('候选人版本无效')
      const jobId = jobBriefStore.list().activeId
      if (!jobId || !recruitmentStore.getCandidate(input.candidateId).jobIds.includes(jobId)) throw new Error('候选人不属于当前岗位')
      const candidate = recruitmentStore.updateCandidate(input.candidateId, input.expectedUpdatedAt, input.changes)
      window?.webContents.send('agenthr:candidates-changed')
      window?.webContents.send('agenthr:records-changed')
      return candidate
    },
    greetQualifiedBossCandidate,
    () => localWorkspace.get(),
    id => {
      const detail = recruitmentStore.getTaskDetail(id)
      const job = detail.task.jobId ? jobBriefStore.list().jobs.find(record => record.id === detail.task.jobId) ?? null : null
      let candidate = null
      if (detail.task.currentCandidateId) {
        try { candidate = recruitmentStore.getCandidate(detail.task.currentCandidateId) } catch { /* linked candidate may have been merged */ }
      }
      return { ...detail, job, candidate }
    },
    (id, value) => {
      const detail = recruitmentStore.appendTaskEntry(id, withValidatedWorkspacePaths(value), currentSafeBrowserUrl())
      window?.webContents.send('agenthr:tasks-changed')
      window?.webContents.send('agenthr:records-changed')
      return detail
    },
  )
  const address = await bridge.start()
  dsh = new DshHost(app.getPath('userData'), address, (status: DshStatus) => {
    emitStatus()
    void syncDshView(status).catch(error => console.error('[DSH view]', error))
  }, localWorkspace.get().path)
  ipcMain.handle('agenthr:status', () => ({ browser: browser ? { ...browser.getStatus(), active: true } : undefined, dsh: dsh?.getStatus(), workspace: localWorkspace.get(), shell: { browserMode, rightTab, browserControl, workspaceTab, navWidth, navCollapsed, rightWidth } }))
  ipcMain.handle('agenthr:set-pane-layout', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('栏位尺寸无效')
    const layout = value as { navWidth?: unknown; rightWidth?: unknown; navCollapsed?: unknown }
    if (typeof layout.navCollapsed === 'boolean' && layout.navCollapsed !== navCollapsed) {
      if (layout.navCollapsed) expandedNavWidth = navWidth
      navCollapsed = layout.navCollapsed
      navWidth = navCollapsed ? 64 : expandedNavWidth
    }
    if (typeof layout.navWidth === 'number' && Number.isFinite(layout.navWidth) && !navCollapsed) {
      navWidth = Math.round(Math.min(320, Math.max(180, layout.navWidth)))
      expandedNavWidth = navWidth
    }
    if (typeof layout.rightWidth === 'number' && Number.isFinite(layout.rightWidth)) rightWidth = Math.round(Math.min(1000, Math.max(420, layout.rightWidth)))
    syncViewBounds()
    emitStatus()
  })
  ipcMain.handle('agenthr:select-platform', async (_event, platform: unknown) => {
    assertPlatform(platform)
    if (agentBrowserActionInFlight) throw new Error('Agent 正在操作浏览器，请等待动作结束')
    await selectPlatform(platform)
  })
  ipcMain.handle('agenthr:open-page', async (_event, page: unknown) => {
    if (offlineSmoke) throw new Error('Offline smoke disables recruitment-site navigation')
    assertPage(page)
    setRightTab('browser')
    if (agentBrowserActionInFlight) throw new Error('Agent 正在操作浏览器，请等待动作结束')
    await browser?.open(page)
  })
  ipcMain.handle('agenthr:reload-page', () => {
    if (agentBrowserActionInFlight) throw new Error('Agent 正在操作浏览器，请等待动作结束')
    return offlineSmoke ? undefined : browser?.reload()
  })
  ipcMain.handle('agenthr:set-browser-mode', (_event, mode: unknown) => {
    if (mode !== 'collapsed' && mode !== 'split' && mode !== 'fullscreen') throw new Error('未知浏览器显示模式')
    setBrowserMode(mode)
  })
  ipcMain.handle('agenthr:set-right-tab', (_event, tab: unknown) => {
    if (tab !== 'files' && tab !== 'browser') throw new Error('未知右侧标签')
    setRightTab(tab)
  })
  ipcMain.handle('agenthr:pick-files', async () => {
    if (!window) return []
    const selection = await dialog.showOpenDialog(window, {
      title: '导入到工作目录', properties: ['openFile', 'multiSelections'],
    })
    if (selection.canceled) return []
    const files = localWorkspace.importFiles(selection.filePaths)
    window.webContents.send('agenthr:workspace-changed')
    return files
  })
  ipcMain.handle('agenthr:list-workspace-files', () => localWorkspace.listFiles())
  ipcMain.handle('agenthr:choose-workspace', async () => {
    if (!window) throw new Error('应用窗口不可用')
    const selection = await dialog.showOpenDialog(window, {
      title: '选择 AgentHR 工作目录', defaultPath: localWorkspace.get().path,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return localWorkspace.get()
    const workspace = localWorkspace.set(selection.filePaths[0])
    await dsh?.setWorkspaceDirectory(workspace.path)
    window.webContents.send('agenthr:workspace-changed')
    emitStatus()
    return workspace
  })
  ipcMain.handle('agenthr:set-browser-control', async (_event, control: unknown) => {
    if (control !== 'agent' && control !== 'human') throw new Error('未知浏览器控制状态')
    if (control === 'human' && agentBrowserActionInFlight) throw new Error('Agent 页面动作尚未结束，请稍后接管')
    browserControl = control
    await Promise.all([...browsers.values()].map(candidate => candidate.setHumanControl(control === 'human')))
    emitStatus()
  })
  ipcMain.handle('agenthr:list-visible-candidates', () => browser?.listVisibleCandidates() ?? [])
  ipcMain.handle('agenthr:capture-visible-candidates', async () => (await captureVisibleCandidates()).records)
  ipcMain.handle('agenthr:greet-boss-candidate', (_event, value: unknown) => greetQualifiedBossCandidate(value))
  ipcMain.handle('agenthr:list-candidates', (_event, scope: unknown = 'active') => {
    if (scope !== 'active' && scope !== 'all') throw new Error('人才库筛选范围无效')
    const jobId = jobBriefStore.list().activeId
    return scope === 'active' ? (jobId ? recruitmentStore.listCandidates(100, jobId) : []) : recruitmentStore.listCandidates()
  })
  ipcMain.handle('agenthr:set-candidate-stage', (_event, candidateId: unknown, stage: unknown, expectedUpdatedAt: unknown) => {
    if (typeof candidateId !== 'string') throw new Error('候选人 ID 无效')
    if (typeof expectedUpdatedAt !== 'string') throw new Error('候选人版本无效')
    const jobId = jobBriefStore.list().activeId
    if (!jobId) throw new Error('请先选择当前岗位')
    const candidate = recruitmentStore.setApplicationStage(candidateId, jobId, stage as CandidateStage, expectedUpdatedAt)
    window?.webContents.send('agenthr:candidates-changed')
    window?.webContents.send('agenthr:records-changed')
    return candidate
  })
  ipcMain.handle('agenthr:update-candidate', (_event, id: unknown, expectedUpdatedAt: unknown, value: unknown) => {
    if (typeof id !== 'string' || typeof expectedUpdatedAt !== 'string') throw new Error('候选人版本无效')
    const candidate = recruitmentStore.updateCandidate(id, expectedUpdatedAt, value)
    window?.webContents.send('agenthr:candidates-changed')
    window?.webContents.send('agenthr:records-changed')
    return candidate
  })
  ipcMain.handle('agenthr:merge-candidates', (_event, value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('候选人合并请求无效')
    const input = value as Record<string, unknown>
    if (input.confirmed !== true || typeof input.primaryId !== 'string' || typeof input.duplicateId !== 'string'
      || typeof input.expectedPrimaryUpdatedAt !== 'string' || typeof input.expectedDuplicateUpdatedAt !== 'string') throw new Error('候选人合并需要明确确认')
    const candidate = recruitmentStore.mergeCandidates(input.primaryId, input.duplicateId, input.expectedPrimaryUpdatedAt, input.expectedDuplicateUpdatedAt)
    window?.webContents.send('agenthr:candidates-changed')
    window?.webContents.send('agenthr:records-changed')
    return candidate
  })
  ipcMain.handle('agenthr:read-open-resume', () => browser?.readOpenResume() ?? Promise.reject(new Error('Browser unavailable')))
  ipcMain.handle('agenthr:save-open-resume', async (_event, candidateId: unknown) => {
    if (typeof candidateId !== 'string') throw new Error('候选人 ID 无效')
    const candidate = recruitmentStore.getCandidate(candidateId)
    const sourceBrowser = browser
    if (!sourceBrowser) throw new Error('招聘页面不可用')
    const resume = await sourceBrowser.readOpenResume()
    if (browser !== sourceBrowser) throw new Error('招聘平台已切换，请重新读取简历')
    const capturedAt = new Date().toISOString()
    const stamp = capturedAt.replace(/[:.]/gu, '-')
    const content = `# ${resume.name || candidate.displayName}\n\n`
      + `- 候选人 ID：${candidate.id}\n- 平台：${sourceBrowser.platform}\n- 来源：${sourceBrowser.getStatus().url}\n- 保存时间：${capturedAt}\n\n`
      + `## 本地候选人资料\n\n\`\`\`json\n${JSON.stringify({ displayName: candidate.displayName, currentCompany: candidate.currentCompany, currentTitle: candidate.currentTitle, location: candidate.location, expectedSalary: candidate.expectedSalary, expectedPosition: candidate.expectedPosition, tags: candidate.tags, notes: candidate.notes }, null, 2)}\n\`\`\`\n\n`
      + `## 简历页面快照\n\n${resume.text}\n`
    const file = localWorkspace.writeTextArtifact(join('candidates', candidate.id, `${stamp}-resume.md`), content)
    window?.webContents.send('agenthr:workspace-changed')
    recruitmentStore.recordEvent('candidate.resume_exported', 'candidate', candidate.id, `保存${candidate.displayName}的简历快照到工作目录`)
    window?.webContents.send('agenthr:records-changed')
    return file
  })
  ipcMain.handle('agenthr:get-job-brief', () => jobBriefStore.load())
  ipcMain.handle('agenthr:list-jobs', () => jobBriefStore.list())
  ipcMain.handle('agenthr:save-job-brief', (_event, value: unknown, expectedUpdatedAt: unknown) => {
    if (typeof expectedUpdatedAt !== 'string') throw new Error('岗位版本无效')
    const record = jobBriefStore.save(value, expectedUpdatedAt)
    recruitmentStore.recordEvent('job.updated', 'job', record.id, `更新岗位：${record.role}`)
    window?.webContents.send('agenthr:records-changed')
    return record
  })
  ipcMain.handle('agenthr:create-job', (_event, value: unknown) => {
    const record = jobBriefStore.create(value)
    recruitmentStore.recordEvent('job.created', 'job', record.id, `创建岗位：${record.role}`)
    window?.webContents.send('agenthr:records-changed')
    return record
  })
  ipcMain.handle('agenthr:activate-job', (_event, id: unknown) => jobBriefStore.activate(id))
  ipcMain.handle('agenthr:clear-active-job', () => jobBriefStore.clearActive())
  ipcMain.handle('agenthr:list-assessments', (_event, scope: unknown = 'all') => {
    if (scope !== 'active' && scope !== 'all') throw new Error('分析队列筛选范围无效')
    const jobsByDigest = new Map(jobBriefStore.list().jobs.map(job => [jobBriefDigest(job), job.id]))
    const decorate = (card: ReturnType<typeof assessmentStore.list>[number]) => ({ ...card,
      greeting: recruitmentStore.getGreetingForAssessment(card.id)
        ?? (jobsByDigest.get(card.jobBriefDigest) ? recruitmentStore.findGreeting(jobsByDigest.get(card.jobBriefDigest)!, card.sourceDigest) : null) })
    if (scope === 'all') return assessmentStore.list().map(decorate)
    const brief = jobBriefStore.load()
    return brief ? assessmentStore.list(100, jobBriefDigest(brief)).map(decorate) : []
  })
  ipcMain.handle('agenthr:set-review-status', (_event, id: unknown, status: unknown) => {
    if (typeof id !== 'string' || id.length < 1 || id.length > 100) throw new Error('分析卡片标识无效')
    const card = assessmentStore.setReviewStatus(id, status as ReviewStatus)
    recruitmentStore.recordEvent('assessment.review_changed', 'assessment', id, `更新${card.candidateName || '候选人'}的人工复核状态：${card.reviewStatus}`)
    window?.webContents.send('agenthr:records-changed')
    return card
  })
  ipcMain.handle('agenthr:list-tasks', (_event, scope: unknown = 'active') => {
    if (scope !== 'active' && scope !== 'all') throw new Error('任务筛选范围无效')
    const jobId = jobBriefStore.list().activeId
    return scope === 'active' ? (jobId ? recruitmentStore.listTasks(100, jobId) : []) : recruitmentStore.listTasks()
  })
  ipcMain.handle('agenthr:create-task', (_event, value: unknown) => {
    const task = recruitmentStore.createTask(withValidatedWorkspacePaths(value))
    window?.webContents.send('agenthr:tasks-changed')
    return task
  })
  ipcMain.handle('agenthr:get-task', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('任务 ID 无效')
    return recruitmentStore.getTaskDetail(id)
  })
  ipcMain.handle('agenthr:add-task-note', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') throw new Error('任务 ID 无效')
    const detail = recruitmentStore.appendTaskEntry(id, { ...(typeof value === 'object' && value !== null ? value : {}), kind: 'note' })
    window?.webContents.send('agenthr:tasks-changed')
    window?.webContents.send('agenthr:records-changed')
    return detail
  })
  ipcMain.handle('agenthr:work-on-task', async (_event, id: unknown, mode: unknown) => {
    if (typeof id !== 'string' || (mode !== 'continue' && mode !== 'new_session')) throw new Error('任务执行请求无效')
    recruitmentStore.getTask(id)
    await insertTaskPrompt(id, mode === 'new_session')
    const updated = recruitmentStore.beginTaskRun(id)
    window?.webContents.send('agenthr:tasks-changed')
    return updated
  })
  ipcMain.handle('agenthr:set-task-status', (_event, id: unknown, status: unknown, expectedUpdatedAt: unknown) => {
    if (typeof id !== 'string' || typeof expectedUpdatedAt !== 'string') throw new Error('任务版本无效')
    const task = recruitmentStore.setTaskStatus(id, status as TaskStatus, expectedUpdatedAt)
    window?.webContents.send('agenthr:tasks-changed')
    return task
  })
  ipcMain.handle('agenthr:list-recruitment-events', () => recruitmentStore.listEvents())
  ipcMain.handle('agenthr:list-platform-validations', () => recruitmentStore.listPlatformValidations())
  ipcMain.handle('agenthr:validate-platform', (_event, check: unknown) => {
    if (check !== 'candidate_list' && check !== 'resume_detail') throw new Error('平台验收类型无效')
    return validatePlatform(check)
  })
  ipcMain.handle('agenthr:open-dsh', async () => {
    const status = dsh?.getStatus()
    if (status?.phase !== 'ready' || !status.url) throw new Error('DSH Host 尚未启动')
    if (dshWindow && !dshWindow.isDestroyed()) { dshWindow.focus(); return }
    dshWindow = new BrowserWindow({
      width: 1100, height: 800, title: 'DSH · AgentHR',
      webPreferences: { partition: 'persist:agenthr-dsh', nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    dshWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    dshWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== new URL(status.url!).origin) event.preventDefault()
    })
    await dshWindow.loadURL(dshView ? new URL('/', status.url).href : status.url)
  })
  ipcMain.handle('agenthr:restart-dsh', async () => {
    if (offlineSmoke) throw new Error('离线验证模式不启动 DSH')
    if (!dsh) throw new Error('DSH Host 不可用')
    if (!['failed', 'stopped', 'unconfigured'].includes(dsh.getStatus().phase)) {
      throw new Error('DSH Host 正在启动或运行中')
    }
    if (dshWindow && !dshWindow.isDestroyed()) dshWindow.close()
    dshWindow = undefined
    await dsh.restart()
  })
  ipcMain.handle('agenthr:set-workspace-tab', (_event, tab: unknown) => {
    if (tab !== 'chat' && tab !== 'workspace') throw new Error('未知工作台页面')
    workspaceTab = tab
    syncViewBounds()
  })
  ipcMain.handle('agenthr:insert-dsh-prompt', async (_event, prompt: unknown) => {
    if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 1000) throw new Error('提示词长度无效')
    if (!dshView || dsh?.getStatus().phase !== 'ready') throw new Error('Agent 对话尚未就绪')
    workspaceTab = 'chat'
    syncViewBounds()
    const focused: unknown = await dshView.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[data-composer-input][contenteditable="true"]')
      if (!input) return false
      input.focus()
      return true
    })()`)
    if (focused !== true) throw new Error('请先在 Agent 对话中创建会话')
    dshView.webContents.focus()
    await dshView.webContents.insertText(prompt)
  })
  ipcMain.handle('agenthr:new-dsh-session', async () => {
    if (!dshView || dsh?.getStatus().phase !== 'ready') throw new Error('Agent 对话尚未就绪')
    const opened = await dshView.webContents.executeJavaScript(`(() => {
      if (Array.from(document.querySelectorAll('h2')).some(el => el.textContent?.includes('Internal Testing Notice'))) return false
      const button = Array.from(document.querySelectorAll('button')).find(el => /new session|新会话/iu.test(el.textContent ?? '') || /new session|新会话/iu.test(el.getAttribute('aria-label') ?? ''))
      if (!button) return false
      button.click()
      return true
    })()`)
    if (opened !== true) throw new Error('请先确认 DSH 的首次使用提示')
    workspaceTab = 'chat'
    syncViewBounds()
    dshView.webContents.focus()
  })
  await createWindow()
  if (offlineSmoke) {
    try {
      await verifyOfflineWindow()
      if (offlineChatSmoke) {
        await dsh.start()
        const deadline = Date.now() + 45_000
        while (Date.now() < deadline) {
          if (dsh.getStatus().phase === 'failed') throw new Error(dsh.getStatus().detail || 'DSH failed')
          if (dshView && dshView.webContents.getURL().startsWith('http://127.0.0.1:') && !dshView.webContents.isLoading()) {
            const ui: unknown = await dshView.webContents.executeJavaScript('document.body.innerText')
            if (typeof ui === 'string' && ui.trim().length > 20) {
              const sidebarDisplay = await dshView.webContents.executeJavaScript(`(() => { const rail = document.querySelector('[class*="sidebarCol"]'); return rail ? getComputedStyle(rail).display : 'missing' })()`)
              if (sidebarDisplay === 'none') throw new Error('Embedded DSH navigation was unexpectedly hidden')
              await dshView.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Continue')?.click()`)
              await new Promise(resolveWait => setTimeout(resolveWait, 350))
              setBrowserMode('collapsed')
              workspaceTab = 'chat'
              await window!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('nav button')).find(button => button.textContent?.includes('AI 工作台'))?.click()`)
              syncViewBounds()
              await new Promise(resolveWait => setTimeout(resolveWait, 250))
              if (dshView.getBounds().width === 0) throw new Error('DSH workbench view did not become visible')
              const screenshot = await window!.capturePage()
              writeFileSync(join(app.getPath('userData'), 'agenthr-chat-smoke.png'), screenshot.toPNG())
              const chatScreenshot = await dshView.webContents.capturePage()
              writeFileSync(join(app.getPath('userData'), 'agenthr-dsh-view-smoke.png'), chatScreenshot.toPNG())
              console.log('AGENTHR_OFFLINE_CHAT_SMOKE_OK')
              break
            }
          }
          await new Promise(resolveWait => setTimeout(resolveWait, 250))
        }
        if (Date.now() >= deadline) throw new Error('Embedded DSH chat did not render')
      }
      app.quit()
    }
    catch (error) { console.error('[offline smoke]', error); app.exit(1) }
  } else {
    void dsh.start().catch(error => console.error('[dsh]', error))
  }
})

app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void (async () => {
    try { await dsh?.shutdown() } catch (error) { console.error('[DSH shutdown]', error) }
    try { await bridge?.stop() } catch (error) { console.error('[bridge shutdown]', error) }
    try { assessmentStore?.close() } catch (error) { console.error('[database shutdown]', error) }
    try { recruitmentStore?.close() } catch (error) { console.error('[recruitment database shutdown]', error) }
  })().finally(() => app.quit())
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!window) void createWindow() })
