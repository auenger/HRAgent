import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDshReadyUrl, resolveDshCli } from '../dist/main/dsh-host.js'

test('DSH Host resolves the pinned local runtime without a sibling checkout', () => {
  const cli = resolveDshCli()
  assert.match(cli ?? '', /@deepseek-ai[\/]dsh[\/]lib[\/]bin\.js$/)
  assert.equal(resolveDshCli('/definitely/missing/dsh/bin.js'), undefined)
})

test('DSH Host retains the authenticated Web launch URL', () => {
  const line = 'dsh web: http://127.0.0.1:4567/?token=secret-token (LAN: http://192.168.1.5:4567/?token=secret-token)\n'
  assert.equal(parseDshReadyUrl(line, 4567), 'http://127.0.0.1:4567/?token=secret-token')
  assert.equal(parseDshReadyUrl(line, 9999), undefined)
  assert.equal(parseDshReadyUrl('dsh web: http://127.0.0.1:4567/\n', 4567), undefined)
})
