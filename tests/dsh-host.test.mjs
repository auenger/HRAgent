import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHost, parseDshReadyUrl, resolveDshCli } from '../dist/main/dsh-host.js'

test('DSH Host resolves the pinned local runtime without a sibling checkout', () => {
  const cli = resolveDshCli()
  assert.ok((cli ?? '').endsWith(join('@deepseek-ai', 'dsh', 'lib', 'bin.js')))
  assert.equal(resolveDshCli('/definitely/missing/dsh/bin.js'), undefined)
})

test('DSH Host retains the authenticated Web launch URL', () => {
  const line = 'dsh web: http://127.0.0.1:4567/?token=secret-token (LAN: http://192.168.1.5:4567/?token=secret-token)\n'
  assert.equal(parseDshReadyUrl(line, 4567), 'http://127.0.0.1:4567/?token=secret-token')
  assert.equal(parseDshReadyUrl(line, 9999), undefined)
  assert.equal(parseDshReadyUrl('dsh web: http://127.0.0.1:4567/\n', 4567), undefined)
})

test('DSH Host restart reaps the previous child before launching a new one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthr-host-restart-'))
  const cli = join(home, 'fake-dsh.mjs')
  const pidFile = join(home, 'pids.txt')
  writeFileSync(cli, `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.AGENTHR_FAKE_PID_FILE, process.pid + '\\n')
const port = process.argv[process.argv.indexOf('--port') + 1]
console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake')
setInterval(() => {}, 1000)
`)
  const oldCli = process.env.AGENTHR_DSH_CLI
  const oldPidFile = process.env.AGENTHR_FAKE_PID_FILE
  process.env.AGENTHR_DSH_CLI = cli
  process.env.AGENTHR_FAKE_PID_FILE = pidFile
  const statuses = []
  const host = new DshHost(home, { url: 'http://127.0.0.1:1', token: 'synthetic' }, status => statuses.push(status))
  const waitForReadyCount = async count => {
    const deadline = Date.now() + 5000
    while (statuses.filter(status => status.phase === 'ready').length < count && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    assert.equal(statuses.filter(status => status.phase === 'ready').length, count)
  }
  try {
    await host.start()
    await waitForReadyCount(1)
    const firstPid = Number(readFileSync(pidFile, 'utf8').trim())
    await host.restart()
    await waitForReadyCount(2)
    const secondPid = Number(readFileSync(pidFile, 'utf8').trim().split('\n')[1])
    assert.notEqual(secondPid, firstPid)
    assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' })
    await host.shutdown()
    assert.equal(host.getStatus().phase, 'stopped')
    assert.throws(() => process.kill(secondPid, 0), { code: 'ESRCH' })
    await assert.rejects(host.restart(), /已关闭/u)
  } finally {
    await host.shutdown()
    if (oldCli === undefined) delete process.env.AGENTHR_DSH_CLI
    else process.env.AGENTHR_DSH_CLI = oldCli
    if (oldPidFile === undefined) delete process.env.AGENTHR_FAKE_PID_FILE
    else process.env.AGENTHR_FAKE_PID_FILE = oldPidFile
    rmSync(home, { recursive: true, force: true })
  }
})
