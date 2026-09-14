import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { BridgeAddress } from './bridge.js'
import { prepareDshProfile } from './dsh-profile.js'

export interface DshStatus {
  phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'
  url?: string
  detail?: string
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

  constructor(private readonly userData: string, private readonly bridge: BridgeAddress, private readonly onStatus: (status: DshStatus) => void) {}

  getStatus(): DshStatus { return { ...this.state } }

  private update(status: DshStatus): void {
    this.state = status
    this.onStatus({ ...status })
  }

  async start(): Promise<void> {
    const cli = resolveDshCli()
    if (!cli) {
      this.update({ phase: 'unconfigured', detail: '未找到 DSH 运行时。检查安装包或设置 AGENTHR_DSH_CLI。' })
      return
    }
    const port = await availablePort()
    const home = resolve(this.userData, 'dsh')
    mkdirSync(home, { recursive: true })
    const plugin = resolve(import.meta.dirname, '../plugin/index.js')
    if (!existsSync(plugin)) throw new Error(`AgentHR DSH plugin missing: ${plugin}`)
    const patch = prepareDshProfile(home, plugin)
    this.stopping = false
    this.update({ phase: 'starting', detail: '正在启动 DSH Host…' })
    const node = process.env.AGENTHR_NODE_BIN || process.execPath
    const runAsNode = node === process.execPath && Boolean(process.versions.electron)
    const child = spawn(node, [cli, 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: dirname(cli),
      env: {
        ...process.env,
        ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        DSH_HOME: home, AGENTHR_BRIDGE_URL: this.bridge.url, AGENTHR_BRIDGE_TOKEN: this.bridge.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let stdoutTail = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      stdoutTail = (stdoutTail + data).slice(-4000)
      const url = parseDshReadyUrl(stdoutTail, port)
      if (url && this.state.phase !== 'ready') this.update({ phase: 'ready', url })
    })
    child.stderr.resume()
    child.on('error', error => this.update({ phase: 'failed', detail: error.message }))
    child.on('exit', code => {
      this.child = undefined
      if (!this.stopping) this.update({ phase: 'failed', detail: `DSH Host 已退出 (${code})。` })
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
    this.update({ phase: 'stopped' })
  }
}
