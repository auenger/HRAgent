import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { BridgeAddress } from './bridge.js'
import { prepareDshProfile } from './dsh-profile.js'
import { bindDshWorkspace } from './dsh-workspace.js'

export interface DshStatus {
  phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'
  url?: string
  detail?: string
  workspacePath?: string
}

/** DSH Web prints a one-use launch URL; opening the bare origin misses its auth cookie. */
export function parseDshReadyUrl(output: string, port: number): string | undefined {
  const expected = `http://127.0.0.1:${port}`
  for (const match of output.matchAll(/^dsh web: (https?:\/\/\S+)/gmu)) {
    try {
      const url = new URL(match[1])
      if (url.origin === expected && url.searchParams.has('token')) return url.href
    } catch { /* ignore incomplete startup output */ }
  }
  return undefined
}

/** Prefer the version pinned in AgentHR; the sibling checkout is only a dev fallback. */
export function resolveDshCli(override = process.env.AGENTHR_DSH_CLI): string | undefined {
  if (override) return existsSync(override) ? resolve(override) : undefined
  try {
    const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    const bundled = join(dirname(manifest), 'lib', 'bin.js')
    if (existsSync(bundled)) return bundled
  } catch { /* dependency may be absent in a local development checkout */ }
  const sibling = resolve(process.cwd(), '../dsh/apps/cli/lib/bin.js')
  return existsSync(sibling) ? sibling : undefined
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No loopback port')); return }
      server.close(() => resolvePort(address.port))
    })
  })
}

export class DshHost {
  private child?: ChildProcess
  private state: DshStatus = { phase: 'unconfigured' }
  private stopping = false
  private closed = false
  private generation = 0
  private restartTask?: Promise<void>

  constructor(private readonly userData: string, private readonly bridge: BridgeAddress, private readonly onStatus: (status: DshStatus) => void, private workspaceDirectory = process.cwd()) {}

  getStatus(): DshStatus { return { ...this.state } }

  private update(status: DshStatus): void {
    this.state = status
    this.onStatus({ ...status })
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('DSH Host 已关闭')
    if (this.child || this.state.phase === 'starting') return
    const generation = ++this.generation
    this.stopping = false
    this.update({ phase: 'starting', detail: '正在启动 DSH Host…', workspacePath: this.workspaceDirectory })
    try {
      const cli = resolveDshCli()
      if (!cli) {
        this.update({ phase: 'unconfigured', detail: '未找到 DSH 运行时。检查安装包或设置 AGENTHR_DSH_CLI。' })
        return
      }
      const port = await availablePort()
      if (generation !== this.generation || this.closed) return
      const home = resolve(this.userData, 'dsh')
      mkdirSync(home, { recursive: true })
      bindDshWorkspace(home, this.workspaceDirectory)
      const plugin = resolve(import.meta.dirname, '../plugin/index.js')
      if (!existsSync(plugin)) throw new Error(`AgentHR DSH plugin missing: ${plugin}`)
      const patch = prepareDshProfile(home, plugin)
      const node = process.env.AGENTHR_NODE_BIN || process.execPath
      const runAsNode = node === process.execPath && Boolean(process.versions.electron)
      const child = spawn(node, [cli, 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: this.workspaceDirectory,
        env: {
          ...process.env,
          ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          DSH_HOME: home, AGENTHR_WORKSPACE_DIR: this.workspaceDirectory, AGENTHR_BRIDGE_URL: this.bridge.url, AGENTHR_BRIDGE_TOKEN: this.bridge.token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      let stdoutTail = ''
      let stderrTail = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (data: string) => {
        if (generation !== this.generation || this.child !== child || this.stopping) return
        stdoutTail = (stdoutTail + data).slice(-4000)
        const url = parseDshReadyUrl(stdoutTail, port)
        if (url && this.state.phase !== 'ready') this.update({ phase: 'ready', url, workspacePath: this.workspaceDirectory })
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data: string) => { stderrTail = (stderrTail + data).slice(-8000) })
      child.on('error', error => {
        if (generation === this.generation && !this.stopping) this.update({ phase: 'failed', detail: error.message })
      })
      child.on('exit', code => {
        if (this.child === child) this.child = undefined
        if (generation === this.generation && !this.stopping) {
          const diagnostic = stderrTail.trim().slice(-1600)
          this.update({ phase: 'failed', detail: diagnostic ? `DSH Host 已退出 (${code})。${diagnostic}` : `DSH Host 已退出 (${code})。` })
        }
      })
    } catch (error) {
      if (generation === this.generation) this.update({ phase: 'failed', detail: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private async stop(): Promise<void> {
    ++this.generation
    this.stopping = true
    this.update({ phase: 'stopped' })
    const child = this.child
    if (!child) return
    await new Promise<void>(resolveStop => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      timeout.unref()
      child.once('close', () => { clearTimeout(timeout); resolveStop() })
      child.kill('SIGTERM')
    })
    if (this.child === child) this.child = undefined
  }

  async restart(): Promise<void> {
    if (this.closed) throw new Error('DSH Host 已关闭')
    if (this.restartTask) return this.restartTask
    const task = (async () => { await this.stop(); if (!this.closed) await this.start() })()
    this.restartTask = task
    try { await task } finally { if (this.restartTask === task) this.restartTask = undefined }
  }

  async setWorkspaceDirectory(path: string): Promise<void> {
    if (path === this.workspaceDirectory) return
    this.workspaceDirectory = path
    await this.restart()
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.stop()
  }
}
