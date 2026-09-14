import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshHost } from '../dist/main/dsh-host.js'

const home = mkdtempSync(join(tmpdir(), 'agenthr-dsh-restart-'))
const statuses = []
const host = new DshHost(home, { url: 'http://127.0.0.1:1', token: 'isolated-restart-check' }, status => statuses.push(status))

async function waitForReady(count) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = statuses.filter(status => status.phase === 'ready')
    if (ready.length >= count) return ready[count - 1].url
    const latest = statuses.at(-1)
    if (latest?.phase === 'failed' || latest?.phase === 'unconfigured') {
      throw new Error(`DSH Host could not start: ${latest.detail ?? latest.phase}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error('DSH Host did not become ready within 90 seconds')
}

async function verifyPage(url) {
  const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  assert.equal(exchange.status, 303)
  assert.ok(cookie)
  const page = await fetch(new URL('/', url), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000) })
  assert.equal(page.ok, true)
}

try {
  await host.start()
  const first = await waitForReady(1)
  await verifyPage(first)
  await host.restart()
  const second = await waitForReady(2)
  assert.notEqual(second, first)
  await verifyPage(second)
  assert.equal(host.getStatus().phase, 'ready')
  process.stdout.write('Real isolated DSH Host restarted and served its authenticated page twice.\n')
} finally {
  await host.shutdown()
  rmSync(home, { recursive: true, force: true })
}
