import { WebContentsView, type BrowserWindow, type Rectangle, type WebFrameMain } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { PLATFORMS, isRecruitmentUrl, type Platform, type RecruitmentPage } from './platforms.js'
import { extractLiepinPreviews, extractOpenLiepinResume, parseCandidatePreviews, parseOpenResume, type CandidatePreview, type OpenResume } from './adapters/liepin.js'
import { extractBossPreviews, extractOpenBossResume, hasSingleVisibleBossFrame } from './adapters/boss.js'
import { resumeDigest } from './assessments.js'
import { animateOpenCandidate } from './adapters/candidate-action.js'
import { actOnBrowserFrame, inspectBrowserFrame, type BrowserFrameSnapshot } from './adapters/browser-use.js'

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
  private lastSnapshot?: { id: string; url: string; frames: Map<string, WebFrameMain>; frameUrls: Map<string, string>; signatures: Map<string, string> }

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

  /** Bounded, page-agnostic observation for search results as well as recommendations. */
  async snapshotPage(): Promise<{ snapshotId: string; platform: Platform; path: string; title: string; frames: BrowserFrameSnapshot[] }> {
    const contents = this.view.webContents
    const url = contents.getURL()
    if (!isRecruitmentUrl(url, this.platform) || contents.isLoading()) throw new Error('招聘页面尚未加载完成')
    const frameMap = new Map<string, WebFrameMain>([['main', contents.mainFrame]])
    if (this.platform === 'boss') {
      try { frameMap.set('recommend', await this.getBossRecommendFrame()) } catch { /* not on recommendation page */ }
    }
    const frames: BrowserFrameSnapshot[] = []
    for (const [key, frame] of frameMap) {
      if (frame.isDestroyed() || !isRecruitmentUrl(frame.url, this.platform)) continue
      const frameUrl = frame.url
      const result: unknown = await frame.executeJavaScript(`(${inspectBrowserFrame.toString()})(document, ${JSON.stringify(key)})`)
      if (frame.isDestroyed() || frame.url !== frameUrl || contents.getURL() !== url || contents.isLoading()) throw new Error('读取时页面发生变化，请重试')
      if (!result || typeof result !== 'object') throw new Error('无法读取当前页面')
      const snapshot = result as BrowserFrameSnapshot
      if (!Array.isArray(snapshot.controls) || typeof snapshot.text !== 'string' || snapshot.text.length > 16_000) throw new Error('页面快照格式无效')
      frames.push(snapshot)
    }
    if (frames.length === 0) throw new Error('当前页面没有可读取的站内内容')
    const id = randomBytes(12).toString('hex')
    this.lastSnapshot = { id, url, frames: frameMap,
      frameUrls: new Map(Array.from(frameMap, ([key, frame]) => [key, frame.url])),
      signatures: new Map(frames.flatMap(frame => frame.controls.map(control => [control.ref, control.signature]))) }
    return { snapshotId: id, platform: this.platform, path: new URL(url).pathname, title: contents.getTitle().slice(0, 200), frames }
  }

  async actOnPage(value: unknown): Promise<{ done: boolean; action: string }> {
    if (!value || typeof value !== 'object') throw new Error('浏览器动作格式无效')
    const input = value as Record<string, unknown>
    const snapshot = this.lastSnapshot
    const contents = this.view.webContents
    if (!snapshot || input.snapshotId !== snapshot.id || contents.getURL() !== snapshot.url || contents.isLoading()) throw new Error('页面快照已过期，请重新识别当前页面')
    if (!['fill', 'press_enter', 'click', 'scroll_up', 'scroll_down'].includes(String(input.action))) throw new Error('不支持的浏览器动作')
    if (input.action === 'fill' && (typeof input.value !== 'string' || input.value.length < 1 || input.value.length > 200)) throw new Error('搜索词长度无效')
    const scrolling = input.action === 'scroll_up' || input.action === 'scroll_down'
    if (!scrolling && (typeof input.ref !== 'string' || !snapshot.signatures.has(input.ref))) throw new Error('元素引用无效，请重新识别页面')
    const frameKey = scrolling ? 'main' : (input.ref as string).split(':e')[0]
    const frame = snapshot.frames.get(frameKey)
    if (!frame || frame.isDestroyed() || frame.url !== snapshot.frameUrls.get(frameKey) || !isRecruitmentUrl(frame.url, this.platform)) throw new Error('页面框架已变化，请重试')
    const action = scrolling
      ? { type: 'scroll', direction: input.action === 'scroll_down' ? 'down' : 'up' }
      : { type: input.action, ref: input.ref, value: input.value }
    const expected = scrolling ? '' : snapshot.signatures.get(input.ref as string)!
    const result: unknown = await frame.executeJavaScript(`(() => {
      const inspectBrowserFrame = ${inspectBrowserFrame.toString()};
      return (${actOnBrowserFrame.toString()})(document, ${JSON.stringify(action)}, ${JSON.stringify(expected)});
    })()`)
    if (!result || typeof result !== 'object' || (result as { done?: boolean }).done !== true) throw new Error('页面元素已变化或该动作不可用，请重新识别页面')
    if (input.action === 'press_enter') {
      contents.focus()
      contents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' })
      contents.sendInputEvent({ type: 'char', keyCode: 'Enter' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    }
    this.lastSnapshot = undefined
    return result as { done: boolean; action: string }
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
    return parseCandidatePreviews(result).map(candidate => ({
      ...candidate,
      fingerprint: createHash('sha256').update(JSON.stringify([this.platform, url, candidate])).digest('hex'),
    }))
  }

  async openCandidatePreview(fingerprint: string): Promise<{ opened: boolean; name: string }> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('候选人标识无效')
    const candidates = await this.listVisibleCandidates()
    const matches = candidates.filter(candidate => candidate.fingerprint === fingerprint && candidate.name)
    if (matches.length !== 1) throw new Error('候选人卡片已变化，请重新读取当前列表')
    const contents = this.view.webContents
    const frame = this.platform === 'boss' ? await this.getBossRecommendFrame() : contents.mainFrame
    const input = { ...matches[0], platform: this.platform }
    const result: unknown = await frame.executeJavaScript(`(${animateOpenCandidate.toString()})(document, ${JSON.stringify(input)})`)
    if (!result || typeof result !== 'object' || (result as { opened?: boolean }).opened !== true) {
      throw new Error('候选人详情入口已变化，请重新读取当前列表')
    }
    return result as { opened: boolean; name: string }
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
