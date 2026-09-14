import { WebContentsView, type BrowserWindow, type Rectangle, type WebFrameMain } from 'electron'
import { PLATFORMS, isRecruitmentUrl, type Platform, type RecruitmentPage } from './platforms.js'
import { extractLiepinPreviews, extractOpenLiepinResume, parseCandidatePreviews, parseOpenResume, type CandidatePreview, type OpenResume } from './adapters/liepin.js'
import { extractBossPreviews, extractOpenBossResume, hasSingleVisibleBossFrame } from './adapters/boss.js'
import { resumeDigest } from './assessments.js'

export type { Platform, RecruitmentPage } from './platforms.js'

export interface BrowserStatus {
  platform: Platform
  url: string
  title: string
  loading: boolean
  error?: string
}

/** Electron owns this view; the Agent only receives business operations through adapters. */
export class RecruitmentBrowser {
  readonly view: WebContentsView
  private status: BrowserStatus
  private disposed = false

  constructor(private readonly window: BrowserWindow, readonly platform: Platform, private readonly onStatus: (status: BrowserStatus) => void) {
    this.status = { platform, url: '', title: '', loading: false }
    this.view = new WebContentsView({
      webPreferences: {
        partition: `persist:agenthr-${platform}-primary`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    window.contentView.addChildView(this.view)
    const contents = this.view.webContents
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
    contents.on('did-stop-loading', () => this.update({ loading: false, url: contents.getURL(), title: contents.getTitle() }))
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

  setBounds(bounds: Rectangle): void { this.view.setBounds(bounds) }

  async open(page: RecruitmentPage): Promise<void> {
    const url = PLATFORMS[this.platform].pages[page]
    if (!url) throw new Error(`${PLATFORMS[this.platform].name}的独立沟通页尚未确认`)
    await this.view.webContents.loadURL(url)
  }

  async reload(): Promise<void> {
    this.view.webContents.reload()
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
    return parseCandidatePreviews(result)
  }

  async readOpenResume(): Promise<OpenResume & { sourceDigest: string }> {
    const contents = this.view.webContents
    const url = contents.getURL()
    if (!isRecruitmentUrl(url, this.platform) || !new URL(url).pathname.includes('recommend')) {
      throw new Error(`请先在${PLATFORMS[this.platform].name}推荐页手动打开一份简历`)
    }
    if (contents.isLoading()) throw new Error('页面加载中，请稍后重试')
    let frame = contents.mainFrame
    let recommendFrame: WebFrameMain | undefined
    let extract: (doc: Document) => OpenResume | null = extractOpenLiepinResume
    if (this.platform === 'boss') {
      const recommend = await this.getBossRecommendFrame()
      recommendFrame = recommend
      const hasVisibleDetail: unknown = await recommend.executeJavaScript(
        `(${hasSingleVisibleBossFrame.toString()})(document, "iframe[src*='/web/frame/c-resume/']")`,
      )
      if (hasVisibleDetail !== true) throw new Error('请在 BOSS 推荐页手动打开恰好一份可见简历')
      const frames = recommend.framesInSubtree.filter(candidate => candidate.parent === recommend
        && isRecruitmentUrl(candidate.url, 'boss')
        && new URL(candidate.url).pathname.startsWith('/web/frame/c-resume/')
        && !candidate.isDestroyed())
      if (frames.length !== 1) throw new Error('请在 BOSS 推荐页手动打开恰好一份简历')
      frame = frames[0]
      extract = extractOpenBossResume
    }
    const frameUrl = frame.url
    const result: unknown = await frame.executeJavaScript(`(${extract.toString()})(document)`)
    this.checkReadPage(url)
    if (frame.isDestroyed() || frame.url !== frameUrl) throw new Error('简历框架已变化，请重试')
    if (recommendFrame) {
      if (recommendFrame.isDestroyed() || frame.parent !== recommendFrame
        || await recommendFrame.executeJavaScript(
          `(${hasSingleVisibleBossFrame.toString()})(document, "iframe[src*='/web/frame/c-resume/']")`,
        ) !== true
        || await contents.mainFrame.executeJavaScript(
          `(${hasSingleVisibleBossFrame.toString()})(document, "iframe[name='recommendFrame']")`,
        ) !== true) {
        throw new Error('简历详情已关闭或变化，请重试')
      }
    }
    const resume = parseOpenResume(result)
    return { ...resume, sourceDigest: resumeDigest(resume) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.window.contentView.removeChildView(this.view)
    this.view.webContents.close()
  }
}
