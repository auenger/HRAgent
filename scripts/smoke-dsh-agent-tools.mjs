import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { prepareDshProfile } from '../dist/main/dsh-profile.js'

const home = mkdtempSync(join(tmpdir(), 'agenthr-agent-tools-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let ctx
let handle

try {
  const profileDir = join(home, 'profiles', 'spec')
  mkdirSync(profileDir, { recursive: true })
  const config = join(profileDir, 'cordis.yml')
  writeFileSync(config, '[]\n')
  const settings = join(home, 'settings.yaml')
  writeFileSync(settings, '{}\n')
  const installAnchor = resolve('node_modules/@deepseek-ai/dsh/package.json')
  const patch = prepareDshProfile(home, resolve('dist/plugin/index.js'))
  await healProfilesModuleFallback({ installAnchor, home })
  const patches = [
    ...loadOverlayPatches('agenthr-smoke', resolve('node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')),
    ...loadOverlayPatches('agenthr-smoke', resolve('node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')),
    { id: 'settings', config: { path: settings, watch: false } },
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'session-log-download', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    ...loadOverlayPatches('agenthr-smoke', patch),
  ]
  ctx = await boot('agenthr-smoke', config, patches, bootCtx => {
    bootCtx.provide('connection', {
      fetch: { register: () => () => {} },
      rpc: { intercept: () => () => {} },
    })
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
  const presets = await ctx.agentPresets.list()
  assert.deepEqual(presets.map(preset => preset.id), ['agenthr'])
  handle = await ctx.agents.create({
    sessionId: SessionId('agenthr-smoke'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  const names = ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()
  assert.deepEqual(names, [
    'agenthr_browser_status',
    'agenthr_get_job_brief',
    'agenthr_list_visible_candidates',
    'agenthr_open_candidate_preview',
    'agenthr_open_recommendations',
    'agenthr_read_open_resume',
    'agenthr_save_assessment_draft',
    'agenthr_save_job_brief',
  ])
  process.stdout.write(`AgentHR preset exposes exactly ${names.length} recruitment tools to a DSH agent.\n`)
} finally {
  await handle?.dispose()
  await ctx?.fiber.dispose()
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  rmSync(home, { recursive: true, force: true })
}
