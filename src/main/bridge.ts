import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { BrowserStatus } from './recruitment-browser.js'
import type { CandidatePreview, OpenResume } from './adapters/liepin.js'
import { jobBriefDigest, type JobBrief } from './job-brief.js'
import { resumeDigest, type AssessmentCard } from './assessments.js'

function pageKind(browser: BrowserStatus): 'login' | 'recommend' | 'messages' | 'other' {
  try {
    const path = new URL(browser.url).pathname
    if (path.includes('login')) return 'login'
    if (path.includes('recommend')) return 'recommend'
    if (browser.platform === 'boss' && path === '/web/chat') return 'messages'
  } catch { /* page has not navigated yet */ }
  return 'other'
}

export interface BridgeAddress { url: string; token: string }

/** Loopback-only, token-protected boundary between the DSH process and Electron. */
export class AgentHrBridge {
  private server?: Server
  private readonly token = randomBytes(32).toString('hex')

  constructor(
    private readonly browserStatus: () => BrowserStatus | undefined,
    private readonly listCandidates: () => Promise<CandidatePreview[]>,
    private readonly readResume: () => Promise<OpenResume>,
    private readonly getJobBrief: () => JobBrief | null,
    private readonly saveAssessment: (value: unknown) => Promise<AssessmentCard>,
    private readonly saveJobBrief?: (value: unknown) => Promise<unknown>,
    private readonly openRecommendations?: (platform: 'boss' | 'liepin') => Promise<unknown>,
    private readonly openCandidate?: (fingerprint: string) => Promise<unknown>,
  ) {}

  async start(): Promise<BridgeAddress> {
    const server = createServer((request, response) => {
      const provided = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      const expected = Buffer.from(this.token)
      const actual = Buffer.from(provided)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(401).end()
        return
      }
      if (request.method === 'POST' && (request.url === '/v1/browser/recommend' || request.url === '/v1/candidates/open')) {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (body.length + chunk.length > 2048) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => {
            const input = JSON.parse(body) as Record<string, unknown>
            if (request.url === '/v1/browser/recommend') {
              if (!this.openRecommendations || (input.platform !== 'boss' && input.platform !== 'liepin')) throw new Error('Invalid platform')
              return this.openRecommendations(input.platform)
            }
            if (!this.openCandidate || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error('Invalid candidate')
            return this.openCandidate(input.fingerprint)
          }).then(result => {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ result }))
          }).catch(() => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: '页面或候选人卡片已变化，请重新识别当前页面' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/job-brief') {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (tooLarge) return
          if (body.length + chunk.length > 12_000) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => {
            if (!this.saveJobBrief) throw new Error('Job brief write is unavailable')
            return this.saveJobBrief(JSON.parse(body) as unknown)
          }).then(jobBrief => {
            response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ jobBrief }))
          }).catch(() => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: '岗位未保存；请确认名称、要求和逐项技能条件' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/assessments') {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (tooLarge) return
          if (body.length + chunk.length > 48_000) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => this.saveAssessment(JSON.parse(body) as unknown)).then(card => {
            response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ card }))
          }).catch(() => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: '分析卡片未保存；请确认当前简历、岗位条件和证据原文' }))
          })
        })
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }
      if (request.url === '/v1/candidates/visible') {
        void this.listCandidates().then(candidates => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ candidates }))
        }).catch(() => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '当前页面无法读取候选人卡片' }))
        })
        return
      }
      if (request.url === '/v1/resume/open') {
        void this.readResume().then(resume => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ resume: { ...resume, sourceDigest: resumeDigest(resume) } }))
        }).catch(() => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '没有可读取的当前简历' }))
        })
        return
      }
      if (request.url === '/v1/job-brief') {
        try {
          const jobBrief = this.getJobBrief()
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ jobBrief: jobBrief ? { ...jobBrief, jobBriefDigest: jobBriefDigest(jobBrief) } : null }))
        } catch {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '岗位条件无法读取' }))
        }
        return
      }
      if (request.url !== '/v1/browser/status') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      const browser = this.browserStatus()
      response.end(JSON.stringify({ browser: browser ? {
        platform: browser.platform,
        page: pageKind(browser),
        loading: browser.loading,
      } : null }))
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('Bridge address unavailable')); return }
        resolve({ url: `http://127.0.0.1:${address.port}`, token: this.token })
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()))
    this.server = undefined
  }
}
