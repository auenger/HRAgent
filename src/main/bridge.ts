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

function safeBrowserAddress(value: string): { url: string; path: string } {
  try {
    const parsed = new URL(value)
    return { url: `${parsed.origin}${parsed.pathname}`, path: parsed.pathname }
  } catch {
    return { url: '', path: '' }
  }
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
    private readonly snapshotPage?: () => Promise<unknown>,
    private readonly actOnPage?: (value: unknown) => Promise<unknown>,
    private readonly listTasks?: () => Promise<unknown>,
    private readonly createTask?: (value: unknown) => Promise<unknown>,
    private readonly captureCandidates?: () => Promise<unknown>,
    private readonly listStoredCandidates?: () => Promise<unknown>,
    private readonly updateCandidate?: (value: unknown) => Promise<unknown>,
    private readonly greetCandidate?: (value: unknown) => Promise<unknown>,
    private readonly getWorkspace?: () => unknown,
    private readonly getTaskDetail?: (id: string) => Promise<unknown> | unknown,
    private readonly appendTaskEntry?: (id: string, value: unknown) => Promise<unknown> | unknown,
    private readonly screenshotPage?: () => Promise<unknown>,
    private readonly recordSkillStep?: (id: string, value: unknown) => Promise<unknown> | unknown,
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
      if (request.method === 'POST' && (request.url === '/v1/browser/recommend' || request.url === '/v1/candidates/open' || request.url === '/v1/browser/action')) {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (body.length + chunk.length > 4096) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => {
            const input = JSON.parse(body) as Record<string, unknown>
            if (request.url === '/v1/browser/action') {
              if (!this.actOnPage) throw new Error('Browser action unavailable')
              return this.actOnPage(input)
            }
            if (request.url === '/v1/browser/recommend') {
              if (!this.openRecommendations || (input.platform !== 'boss' && input.platform !== 'liepin')) throw new Error('Invalid platform')
              return this.openRecommendations(input.platform)
            }
            if (!this.openCandidate || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error('Invalid candidate')
            return this.openCandidate(input.fingerprint)
          }).then(result => {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ result }))
          }).catch(error => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '浏览器动作未执行' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/candidates/capture') {
        void Promise.resolve().then(() => {
          if (!this.captureCandidates) throw new Error('Candidate capture unavailable')
          return this.captureCandidates()
        }).then(candidates => {
          response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ candidates }))
        }).catch(() => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '当前候选人线索未保存；请确认推荐页和当前岗位' }))
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/candidates/greet') {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (body.length + chunk.length > 4096) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => {
            if (!this.greetCandidate) throw new Error('Greeting unavailable')
            return this.greetCandidate(JSON.parse(body) as unknown)
          }).then(greeting => {
            response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ greeting }))
          }).catch(error => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 300) : '打招呼未执行' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/candidates/update') {
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
            if (!this.updateCandidate) throw new Error('Candidate update unavailable')
            return this.updateCandidate(JSON.parse(body) as unknown)
          }).then(candidate => {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ candidate }))
          }).catch(() => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: '候选人资料未更新；请重新读取人才库并核对字段' }))
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
          }).catch(error => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '分析卡片未保存' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/tasks') {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (tooLarge) return
          if (body.length + chunk.length > 8_000) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => {
            if (!this.createTask) throw new Error('Task write is unavailable')
            return this.createTask(JSON.parse(body) as unknown)
          }).then(task => {
            response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ task }))
          }).catch(() => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: '招聘任务未创建；请确认岗位、类型和标题' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/tasks/entry') {
        let body = ''
        let tooLarge = false
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (tooLarge) return
          if (body.length + chunk.length > 32_000) { tooLarge = true; return }
          body += chunk
        })
        request.on('end', () => {
          if (tooLarge) { response.writeHead(413).end(); return }
          void Promise.resolve().then(() => {
            const input = JSON.parse(body) as Record<string, unknown>
            if (!this.appendTaskEntry || typeof input.taskId !== 'string') throw new Error('Task result write is unavailable')
            return this.appendTaskEntry(input.taskId, input)
          }).then(taskDetail => {
            response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ taskDetail }))
          }).catch(error => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 300) : '任务结果未保存' }))
          })
        })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/skills/step') {
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
            const input = JSON.parse(body) as Record<string, unknown>
            if (!this.recordSkillStep || typeof input.taskId !== 'string') throw new Error('Skill step write is unavailable')
            return this.recordSkillStep(input.taskId, input)
          }).then(result => {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ result }))
          }).catch(error => {
            response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '技能步骤回执未保存' }))
          })
        })
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }
      if (request.url === '/v1/browser/snapshot') {
        void Promise.resolve().then(() => {
          if (!this.snapshotPage) throw new Error('Browser observation unavailable')
          return this.snapshotPage()
        }).then(snapshot => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ snapshot }))
        }).catch(error => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '当前页面无法读取' }))
        })
        return
      }
      if (request.url === '/v1/browser/screenshot') {
        void Promise.resolve().then(() => {
          if (!this.screenshotPage) throw new Error('Browser screenshot unavailable')
          return this.screenshotPage()
        }).then(screenshot => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ screenshot }))
        }).catch(error => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '当前页面无法截取诊断画面' }))
        })
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
        }).catch(error => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : '当前页面没有可读取的简历详情' }))
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
      if (request.url === '/v1/workspace') {
        try {
          if (!this.getWorkspace) throw new Error('Workspace unavailable')
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ workspace: this.getWorkspace() }))
        } catch {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '工作目录无法读取' }))
        }
        return
      }
      if (request.url === '/v1/tasks') {
        void Promise.resolve().then(() => {
          if (!this.listTasks) throw new Error('Task read is unavailable')
          return this.listTasks()
        }).then(tasks => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ tasks }))
        }).catch(() => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '招聘任务无法读取' }))
        })
        return
      }
      if (request.url?.startsWith('/v1/tasks/detail?')) {
        void Promise.resolve().then(() => {
          const id = new URL(request.url!, 'http://127.0.0.1').searchParams.get('id')
          if (!this.getTaskDetail || !id) throw new Error('Task detail is unavailable')
          return this.getTaskDetail(id)
        }).then(taskDetail => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ taskDetail }))
        }).catch(() => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '任务详情无法读取' }))
        })
        return
      }
      if (request.url === '/v1/candidates') {
        void Promise.resolve().then(() => {
          if (!this.listStoredCandidates) throw new Error('Candidate list unavailable')
          return this.listStoredCandidates()
        }).then(candidates => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ candidates }))
        }).catch(() => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: '人才库无法读取' }))
        })
        return
      }
      if (request.url !== '/v1/browser/status') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      const browser = this.browserStatus()
      if (!browser) { response.end(JSON.stringify({ browser: null })); return }
      const address = safeBrowserAddress(browser.url)
      response.end(JSON.stringify({ browser: {
        platform: browser.platform, page: pageKind(browser), loading: browser.loading, active: true,
        title: browser.title.slice(0, 200), url: address.url, path: address.path,
        lastAction: browser.lastAction,
      } }))
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
