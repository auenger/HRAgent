import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseDshReadyUrl } from '../dist/main/dsh-host.js'
import { prepareDshProfile } from '../dist/main/dsh-profile.js'

const home = mkdtempSync(join(tmpdir(), 'agenthr-dsh-smoke-'))
const server = createServer()
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
await new Promise(resolveClose => server.close(resolveClose))

const packaged = process.argv.includes('--packaged')
const packagedLayouts = {
  darwin: ['release/mac/AgentHR.app/Contents/MacOS/AgentHR', 'release/mac/AgentHR.app/Contents/Resources/app'],
  win32: ['release/win-unpacked/AgentHR.exe', 'release/win-unpacked/resources/app'],
  linux: ['release/linux-unpacked/agenthr', 'release/linux-unpacked/resources/app'],
}
const packagedLayout = packagedLayouts[process.platform]
if (packaged && !packagedLayout) throw new Error(`No packaged layout for ${process.platform}`)
const executable = packaged ? resolve(packagedLayout[0]) : process.execPath
const appRoot = packaged ? resolve(packagedLayout[1]) : undefined
const cli = packaged ? join(appRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js') : resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
const plugin = packaged ? join(appRoot, 'dist/plugin/index.js') : resolve('dist/plugin/index.js')
const patch = prepareDshProfile(home, plugin)
const child = spawn(executable, [cli, 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
  env: {
    ...process.env,
    ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    DSH_HOME: home,
    AGENTHR_BRIDGE_URL: 'http://127.0.0.1:1',
    AGENTHR_BRIDGE_TOKEN: 'offline-smoke-check',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let exited = false
const closed = new Promise(resolveClose => child.once('close', code => { exited = true; resolveClose(code) }))
child.stdout.on('data', chunk => { output += chunk.toString() })
child.stderr.on('data', chunk => { output += chunk.toString() })

try {
  const deadline = Date.now() + 90_000
  let readyUrl
  while (!exited && Date.now() < deadline) {
    readyUrl = parseDshReadyUrl(output, port)
    if (readyUrl) break
    if (/SyntaxError:|does not provide an export named|ERR_MODULE_NOT_FOUND/u.test(output)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  if (!readyUrl) throw new Error(`DSH Host did not announce an authenticated URL: ${output.replace(/token=[^\s&)]+/gu, 'token=[redacted]').slice(0, 5000)}`)
  const exchange = await fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  if (exchange.status !== 303 || !cookie) throw new Error(`DSH Host token exchange answered HTTP ${exchange.status}`)
  const response = await fetch(new URL('/', readyUrl), {
    headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`DSH Host authenticated page answered HTTP ${response.status}`)
  await new Promise(resolveWait => setTimeout(resolveWait, 3000))
  if (exited || /plugin tree failed to load|loader entries failed to apply/u.test(output)) {
    throw new Error(`DSH Host failed after serving the page: ${output.replace(/token=[^\s&)]+/gu, 'token=[redacted]').slice(0, 7000)}`)
  }
  process.stdout.write(`${packaged ? 'Packaged ' : ''}DSH Host served its authenticated local page on port ${port}.\n`)
} finally {
  if (!exited) child.kill('SIGTERM')
  const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 3000)
  await closed
  clearTimeout(timer)
  rmSync(home, { recursive: true, force: true })
}
