import { WebContentsView, type BrowserWindow, type DownloadItem, type Event as ElectronEvent, type Rectangle, type WebFrameMain } from 'electron'
import { createHash } from 'node:crypto'
import { PLATFORMS, isRecruitmentUrl, type Platform, type RecruitmentPage } from './platforms.js'
import { extractLiepinPreviews, extractOpenLiepinResume, parseCandidatePreviews, parseOpenResume, type CandidatePreview, type OpenResume } from './adapters/liepin.js'
import { extractBossPreviews, extractOpenBossResume, hasSingleVisibleBossFrame } from './adapters/boss.js'
import { resumeDigest } from './assessments.js'
import { resolveCandidateDetailTarget } from './adapters/candidate-action.js'
import { restoreBrowserPointer, type PointerPoint } from './adapters/browser-visual.js'
import { setBrowserControlShield } from './adapters/browser-control.js'
import { inspectBossGreetingTarget, resolveBossDetailCloseTarget, resolveBossGreetingTarget } from './adapters/boss-greeting.js'
import { CdpBrowser, type BrowserActionReceipt, type BrowserWaitCondition } from './cdp-browser.js'

export type { Platform, RecruitmentPage } from './platforms.js'

export interface BrowserStatus {
  platform: Platform
  url: string
  title: string
  loading: boolean
  error?: string
  lastAction?: { action: string; target: string; result: 'running' | 'succeeded' | 'failed'; at: string }
  /** Present on status exposed to DSH when this is the browser currently selected for Agent actions. */
  active?: true
}

/** Electron owns this view; the Agent only receives business operations through adapters. */
export class RecruitmentBrowser {
  readonly view: WebContentsView
  private status: BrowserStatus
  private disposed = false
  private humanControl = false
  private agentInputInFlight = false
  private readonly cdp: CdpBrowser
  private lastPointer: PointerPoint | null = null
  private downloadHandler?: (event: ElectronEvent, item: DownloadItem) => void

  constructor(
    private readonly window: BrowserWindow,
    readonly platform: Platform,
    private readonly onStatus: (status: BrowserStatus) => void,
    private readonly requestDownload?: (fileName: string, sourceUrl: string) => Promise<string | null>,
    private readonly onDownloadCompleted?: (path: string) => void,
  ) {
    this.status = { platform, url: '', title: '', loading: false }
    this.view = new WebContentsView({
      webPreferences: {
        partition: `persist:agenthr-${platform}-primary`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    window.contentView.addChildView(this.view)
    const contents = this.view.webContents
    this.cdp = new CdpBrowser(contents, url => isRecruitmentUrl(url, this.platform))
    this.downloadHandler = (_event, item) => {
      item.pause()
      void Promise.resolve(this.requestDownload?.(item.getFilename(), item.getURL()) ?? null).then(target => {
        if (!target || this.disposed) { item.cancel(); return }
        item.setSavePath(target)
        item.once('done', (_doneEvent, state) => {
          if (state === 'completed') this.onDownloadCompleted?.(target)
        })
        item.resume()
      }).catch(() => item.cancel())
    }
    contents.session.on('will-download', this.downloadHandler)
    contents.on('before-input-event', event => {
      if (!this.humanControl && !this.agentInputInFlight) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      this.update({ error: isRecruitmentUrl(url, platform) ? '网站弹窗已拦截；如登录需要弹窗，请记录该步骤。' : '已拦截站外弹窗。' })
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isRecruitmentUrl(url, platform)) {
        event.preventDefault()
        this.update({ error: '已拦截站外跳转。' })
      }
    })
    contents.on('did-start-loading', () => this.update({ loading: true, error: undefined }))
    contents.on('did-stop-loading', () => {
      this.update({ loading: false, url: contents.getURL(), title: contents.getTitle() })
      void this.syncControlShield()
      if (!this.disposed && this.lastPointer && isRecruitmentUrl(contents.getURL(), platform)) {
        void contents.mainFrame.executeJavaScript(`(${restoreBrowserPointer.toString()})(document, ${JSON.stringify(this.lastPointer)})`).catch(() => {})
      }
    })
    contents.on('page-title-updated', (_event, title) => this.update({ title }))
    contents.on('did-navigate-in-page', (_event, url) => this.update({ url }))
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.update({ loading: false, error: `${description} (${url})` })
    })
  }

  private update(partial: Partial<BrowserStatus>): void {
    if (this.disposed) return
    this.status = { ...this.status, ...partial }
    this.onStatus({ ...this.status })
  }

  getStatus(): BrowserStatus { return { ...this.status } }

  private async syncControlShield(): Promise<void> {
    const contents = this.view.webContents
    if (this.agentInputInFlight || contents.isDestroyed() || contents.isLoading() || !isRecruitmentUrl(contents.getURL(), this.platform)) return
    await contents.mainFrame.executeJavaScript(`(${setBrowserControlShield.toString()})(document, ${JSON.stringify(this.humanControl)})`)
  }

  async setHumanControl(humanControl: boolean): Promise<void> {
    this.humanControl = humanControl
    await this.syncControlShield()
  }

  setBounds(bounds: Rectangle): void { this.view.setBounds(bounds) }

  async open(page: RecruitmentPage): Promise<void> {
    const url = PLATFORMS[this.platform].pages[page]
    if (!url) throw new Error(`${PLATFORMS[this.platform].name}的独立沟通页尚未确认`)
    await this.view.webContents.loadURL(url)
  }

  async reload(): Promise<void> {
    this.view.webContents.reload()
  }

  /** Bounded, page-agnostic observation for search results as well as recommendations. */
  async snapshotPage() {
    const contents = this.view.webContents
    const snapshot = await this.cdp.snapshot()
    return { ...snapshot, platform: this.platform, path: new URL(contents.getURL()).pathname, title: contents.getTitle().slice(0, 200) }
  }

  async captureDiagnosticScreenshot(): Promise<{ base64: string; mediaType: 'image/png'; bytes: number; width: number; height: number; digest: string; platform: Platform; path: string; capturedAt: string }> {
    const contents = this.view.webContents
    const url = contents.getURL()
    if (!isRecruitmentUrl(url, this.platform)) throw new Error('当前页面不在招聘浏览器范围内')
    if (/login|passport|signin/iu.test(new URL(url).pathname)) throw new Error('登录页面不提供 Agent 截图诊断，请由用户人工完成登录')
    let image = await contents.capturePage()
    const original = image.getSize()
    const scale = Math.min(1, 1440 / Math.max(1, original.width), 1200 / Math.max(1, original.height))
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(original.width * scale)), height: Math.max(1, Math.round(original.height * scale)), quality: 'good' })
    let png = image.toPNG()
    if (png.byteLength > 4_000_000) {
      const current = image.getSize()
      image = image.resize({ width: Math.max(1, Math.round(current.width * 0.7)), height: Math.max(1, Math.round(current.height * 0.7)), quality: 'good' })
      png = image.toPNG()
    }
    if (png.byteLength > 4_000_000) throw new Error('当前页面截图过大，请缩小招聘浏览器区域后重试')
    const size = image.getSize()
    return { base64: png.toString('base64'), mediaType: 'image/png', bytes: png.byteLength, width: size.width, height: size.height,
      digest: createHash('sha256').update(png).digest('hex'), platform: this.platform, path: new URL(url).pathname, capturedAt: new Date().toISOString() }
  }

  async actOnPage(value: unknown) {
    if (this.agentInputInFlight) throw new Error('浏览器操作进行中，请等待完成')
    if (!value || typeof value !== 'object') throw new Error('浏览器动作格式无效')
    const input = value as Record<string, unknown>
    if (!['fill', 'select', 'press_enter', 'click', 'hover', 'scroll_up', 'scroll_down'].includes(String(input.action))) throw new Error('不支持的浏览器动作')
    if (typeof input.snapshotId !== 'string') throw new Error('缺少页面快照标识')
    if (['fill', 'select'].includes(String(input.action)) && (typeof input.value !== 'string' || input.value.length > 1000)) throw new Error('输入内容长度无效')
    if (input.ref !== undefined && typeof input.ref !== 'string') throw new Error('控件引用无效')
    if (input.frame !== undefined && typeof input.frame !== 'string') throw new Error('框架引用无效')
    let wait: BrowserWaitCondition | undefined
    if (input.wait !== undefined) {
      if (!input.wait || typeof input.wait !== 'object' || Array.isArray(input.wait)) throw new Error('等待条件格式无效')
      const candidate = input.wait as Record<string, unknown>
      const types = ['control_value', 'control_state', 'control_present', 'control_absent', 'text_contains', 'text_absent', 'url_path', 'url_changed']
      if (!types.includes(String(candidate.type))) throw new Error('等待条件类型无效')
      if (candidate.timeoutMs !== undefined && (!Number.isInteger(candidate.timeoutMs) || Number(candidate.timeoutMs) < 100 || Number(candidate.timeoutMs) > 8_000)) throw new Error('等待超时必须在 100 到 8000 毫秒之间')
      const type = String(candidate.type)
      if (type.startsWith('control_') && (typeof candidate.ref !== 'string' || candidate.ref.length > 200)) throw new Error('等待控件引用无效')
      if ((type === 'text_contains' || type === 'text_absent') && (typeof candidate.value !== 'string' || !candidate.value || candidate.value.length > 200)) throw new Error('等待文本无效')
      if ((type === 'text_contains' || type === 'text_absent') && candidate.frame !== undefined && typeof candidate.frame !== 'string') throw new Error('等待框架无效')
      if (type === 'url_path' && (typeof candidate.value !== 'string' || !candidate.value.startsWith('/') || candidate.value.length > 500)) throw new Error('等待路径无效')
      if (type === 'control_state' && !['checked', 'expanded'].includes(String(candidate.state))) throw new Error('等待控件状态无效')
      if (type === 'control_state' && typeof candidate.value !== 'string' && typeof candidate.value !== 'boolean') throw new Error('等待控件状态值无效')
      if (type === 'control_value' && (typeof candidate.value !== 'string' || candidate.value.length > 1000)) throw new Error('等待控件值无效')
      wait = candidate as unknown as BrowserWaitCondition
    }
    const contents = this.view.webContents
    const at = new Date().toISOString()
    const target = String(input.ref || input.frame || '当前页面').slice(0, 120)
    this.update({ lastAction: { action: String(input.action), target, result: 'running', at } })
    this.agentInputInFlight = true
    try {
      // Native CDP input must reach the page rather than the manual-control shield.
      await contents.mainFrame.executeJavaScript(`(${setBrowserControlShield.toString()})(document, true)`)
      contents.focus()
      // A newly shown WebContentsView can have DOM layout before its input surface is ready.
      // Flush a compositor frame after removing the shield; the image is not stored or sent.
      await contents.capturePage()
      const result = await this.cdp.act({ snapshotId: input.snapshotId, action: String(input.action),
        ...(typeof input.ref === 'string' ? { ref: input.ref } : {}), ...(typeof input.value === 'string' ? { value: input.value } : {}),
        ...(typeof input.frame === 'string' ? { frame: input.frame } : {}), ...(wait ? { wait } : {}) })
      if (!contents.isDestroyed() && !contents.isLoading()) {
        await contents.mainFrame.executeJavaScript('new Promise(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })')
      }
      this.update({ lastAction: { action: String(input.action), target, result: 'succeeded', at } })
      return result
    } catch (error) {
      this.update({ lastAction: { action: String(input.action), target, result: 'failed', at } })
      throw error
    } finally {
      this.agentInputInFlight = false
      if (!contents.isDestroyed()) await this.syncControlShield().catch(() => {})
    }
  }

  private async clickResolvedTarget<T>(input: {
    action: string
    label: string
    resolver: (doc: Document, value: T) => HTMLElement | null
    value: T
    visualDurationMs?: number
  }): Promise<{ pointer: PointerPoint; receipt: BrowserActionReceipt }> {
    if (this.agentInputInFlight) throw new Error('浏览器操作进行中，请等待完成')
    const contents = this.view.webContents
    this.agentInputInFlight = true
    try {
      await contents.mainFrame.executeJavaScript(`(${setBrowserControlShield.toString()})(document, true)`)
      contents.focus()
      await contents.capturePage()
      const result = await this.cdp.clickResolvedTarget({ ...input, previousPointer: this.lastPointer })
      this.lastPointer = result.pointer
      return result
    } finally {
      this.agentInputInFlight = false
      if (!contents.isDestroyed()) await this.syncControlShield().catch(() => {})
    }
  }

  private async getBossRecommendFrame(): Promise<WebFrameMain> {
    const contents = this.view.webContents
    const visible: unknown = await contents.mainFrame.executeJavaScript(
      `(${hasSingleVisibleBossFrame.toString()})(document, "iframe[name='recommendFrame']")`,
    )
    if (visible !== true) throw new Error('没有唯一可见的 BOSS 推荐页框架')
    const frames = contents.mainFrame.framesInSubtree.filter(frame =>
      frame.name === 'recommendFrame' && frame.parent === contents.mainFrame
        && isRecruitmentUrl(frame.url, 'boss') && !frame.isDestroyed(),
    )
    if (frames.length !== 1) throw new Error('没有唯一的 BOSS 推荐页框架')
    return frames[0]
  }

  private async closeBossDetailIfOpen(): Promise<void> {
    const frame = await this.getBossRecommendFrame()
    const selector = "iframe[src*='/web/frame/c-resume/']"
    const hasDetail = await frame.executeJavaScript(
      `(${hasSingleVisibleBossFrame.toString()})(document, ${JSON.stringify(selector)})`,
    )
    if (hasDetail !== true) return
    await this.clickResolvedTarget({ action: 'close_candidate_detail', label: '关闭候选人详情',
      resolver: resolveBossDetailCloseTarget, value: undefined, visualDurationMs: 650 })
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    if (frame.isDestroyed() || await frame.executeJavaScript(
      `(${hasSingleVisibleBossFrame.toString()})(document, ${JSON.stringify(selector)})`,
    ) === true) throw new Error('候选人详情未关闭，未执行打招呼')
  }

  private checkReadPage(url: string): void {
    const contents = this.view.webContents
    if (contents.getURL() !== url || contents.isLoading()) throw new Error('读取时页面发生变化，请重试')
  }

  async listVisibleCandidates(): Promise<CandidatePreview[]> {
    const contents = this.view.webContents
    const url = contents.getURL()
    if (!isRecruitmentUrl(url, this.platform) || !new URL(url).pathname.includes('recommend')) {
      throw new Error(`请先在${PLATFORMS[this.platform].name}打开推荐候选人页面`)
    }
    if (contents.isLoading()) throw new Error('页面加载中，请稍后重试')
    const frame = this.platform === 'boss' ? await this.getBossRecommendFrame() : contents.mainFrame
    const frameUrl = frame.url
    const extract = this.platform === 'boss' ? extractBossPreviews : extractLiepinPreviews
    const result: unknown = await frame.executeJavaScript(`(${extract.toString()})(document)`)
    this.checkReadPage(url)
    if (frame.isDestroyed() || frame.url !== frameUrl) throw new Error('候选人列表框架已变化，请重试')
    return parseCandidatePreviews(result).map(candidate => ({
      ...candidate,
      fingerprint: createHash('sha256').update(JSON.stringify([this.platform, url, candidate])).digest('hex'),
    }))
  }

  async openCandidatePreview(fingerprint: string): Promise<{ opened: boolean; name: string; receipt: BrowserActionReceipt }> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('候选人标识无效')
    const candidates = await this.listVisibleCandidates()
    const matches = candidates.filter(candidate => candidate.fingerprint === fingerprint && candidate.name)
    if (matches.length !== 1) throw new Error('候选人卡片已变化，请重新读取当前列表')
    const input = { ...matches[0], platform: this.platform }
    this.update({ lastAction: { action: 'open_candidate', target: matches[0].name.slice(0, 120), result: 'running', at: new Date().toISOString() } })
    let result: { pointer: PointerPoint; receipt: BrowserActionReceipt }
    try {
      result = await this.clickResolvedTarget({ action: 'open_candidate', label: input.name,
        resolver: resolveCandidateDetailTarget, value: input, visualDurationMs: 650 })
    } catch (error) {
      this.update({ lastAction: { action: 'open_candidate', target: matches[0].name.slice(0, 120), result: 'failed', at: new Date().toISOString() } })
      throw error
    }
    this.update({ lastAction: { action: 'open_candidate', target: matches[0].name.slice(0, 120), result: 'succeeded', at: new Date().toISOString() } })
    return { opened: true, name: input.name, receipt: result.receipt }
  }

  /** Explicit, evidence-gated BOSS greeting. Matching is repeated immediately before the click. */
  async greetBossCandidate(fingerprint: string): Promise<{ greeted: boolean; alreadyContacted: boolean; name: string; receipt?: BrowserActionReceipt }> {
    if (this.platform !== 'boss') throw new Error('自动打招呼当前仅支持 BOSS 直聘')
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('候选人标识无效')
    await this.closeBossDetailIfOpen()
    const candidates = await this.listVisibleCandidates()
    const matches = candidates.filter(candidate => candidate.fingerprint === fingerprint && candidate.name)
    if (matches.length !== 1) throw new Error('候选人卡片已变化，请重新读取当前列表')
    const frame = await this.getBossRecommendFrame()
    const input = { ...matches[0], platform: 'boss' as const }
    const targetState = await frame.executeJavaScript(`(${inspectBossGreetingTarget.toString()})(document, ${JSON.stringify(input)})`)
    if (targetState === 'already_contacted') return { greeted: false, alreadyContacted: true, name: input.name }
    if (targetState !== 'ready') throw new Error('未找到唯一可点击的打招呼按钮，请重新读取候选人')
    this.update({ lastAction: { action: 'greet_candidate', target: input.name.slice(0, 120), result: 'running', at: new Date().toISOString() } })
    let result: { pointer: PointerPoint; receipt: BrowserActionReceipt }
    try {
      result = await this.clickResolvedTarget({ action: 'greet_candidate', label: input.name,
        resolver: resolveBossGreetingTarget, value: input, visualDurationMs: 650 })
      this.update({ lastAction: { action: 'greet_candidate', target: input.name.slice(0, 120), result: 'succeeded', at: new Date().toISOString() } })
      return { greeted: true, alreadyContacted: false, name: input.name, receipt: result.receipt }
    } catch (error) {
      this.update({ lastAction: { action: 'greet_candidate', target: input.name.slice(0, 120), result: 'failed', at: new Date().toISOString() } })
      throw error
    }
  }

  async readOpenResume(): Promise<OpenResume & { sourceDigest: string }> {
    const contents = this.view.webContents
    const url = contents.getURL()
    if (!isRecruitmentUrl(url, this.platform)) throw new Error(`当前页面不属于${PLATFORMS[this.platform].name}`)
    if (contents.isLoading()) throw new Error('页面加载中，请稍后重试')
    if (this.platform === 'boss') {
      const result = await this.cdp.readSingleVisibleDocument(extractOpenBossResume.toString())
      this.checkReadPage(url)
      const resume = parseOpenResume(result)
      return { ...resume, sourceDigest: resumeDigest(resume) }
    }
    const result = await this.cdp.readSingleVisibleDocument(extractOpenLiepinResume.toString())
    this.checkReadPage(url)
    const resume = parseOpenResume(result)
    return { ...resume, sourceDigest: resumeDigest(resume) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cdp.dispose()
    if (this.downloadHandler) this.view.webContents.session.removeListener('will-download', this.downloadHandler)
    this.window.contentView.removeChildView(this.view)
    this.view.webContents.close()
  }
}
