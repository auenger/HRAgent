import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { prepareDshProfile } from '../dist/main/dsh-profile.js'

test('current DSH accepts AgentHR-only preset and plugin configuration offline', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthr-dsh-profile-'))
  try {
    const cli = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
    const plugin = resolve('dist/plugin/index.js')
    const patch = prepareDshProfile(home, plugin)
    const persona = readFileSync(join(home, 'agenthr-presets/agenthr/agent.cordis.yml'), 'utf8')
    assert.match(persona, /complete: true/)
    assert.match(persona, /不能把泛称动物实验或 MCAO 自动等同于 tMCAO/)
    assert.match(persona, /sourceDigest.*jobBriefDigest/u)
    assert.match(persona, /可读取并汇总页面或简历中显示的薪资和求职意向/u)
    assert.match(persona, /不要主动向候选人追问或发送消息/u)
    assert.doesNotMatch(persona, /tool-bash|tool-fs/)
    const result = spawnSync(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--dump-config'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DSH_HOME: home },
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.match(result.stdout, /default: agenthr/)
    assert.match(result.stdout, /includeShippedRoot: false/)
    assert.match(result.stdout, /includeUserRoot: false/)
    assert.match(result.stdout, /agenthr-browser-tools/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
