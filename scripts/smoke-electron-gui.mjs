import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executables = {
  darwin: 'release/mac/AgentHR.app/Contents/MacOS/AgentHR',
  win32: 'release/win-unpacked/AgentHR.exe',
  linux: 'release/linux-unpacked/agenthr',
}
const path = executables[process.platform]
if (!path) throw new Error(`No GUI smoke layout for ${process.platform}`)
const home = mkdtempSync(join(tmpdir(), 'agenthr-gui-smoke-'))
const env = { ...process.env, AGENTHR_OFFLINE_SMOKE: '1', AGENTHR_OFFLINE_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(resolve(path), [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
let timeoutId
child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-5000) })
child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-5000) })

try {
  const result = await Promise.race([
    new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', code => resolveExit({ code }))
    }),
    new Promise(resolveTimeout => { timeoutId = setTimeout(() => resolveTimeout({ timeout: true }), 30_000) }),
  ])
  clearTimeout(timeoutId)
  if ('timeout' in result) {
    child.kill('SIGKILL')
    await new Promise(resolveClose => child.once('close', resolveClose))
    throw new Error(`Packaged offline GUI did not finish within 30s: ${output.slice(-1000)}`)
  }
  assert.equal(result.code, 0, output.slice(-1200))
  assert.match(output, /AGENTHR_OFFLINE_SMOKE_OK/u)
  process.stdout.write('Packaged Electron window, renderer, preload bridge, and isolated local storage verified without opening recruitment sites.\n')
} finally {
  clearTimeout(timeoutId)
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
}
