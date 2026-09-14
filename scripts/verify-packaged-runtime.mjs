import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const layouts = {
  darwin: ['release/mac/AgentHR.app/Contents/MacOS/AgentHR', 'release/mac/AgentHR.app/Contents/Resources/app'],
  win32: ['release/win-unpacked/AgentHR.exe', 'release/win-unpacked/resources/app'],
  linux: ['release/linux-unpacked/agenthr', 'release/linux-unpacked/resources/app'],
}
const layout = layouts[process.platform]
if (!layout) throw new Error(`Unsupported package verification platform: ${process.platform}`)
const [executableRelative, appRelative] = layout
const executable = resolve(executableRelative)
const appRoot = resolve(appRelative)
if (!existsSync(executable) || !existsSync(appRoot)) throw new Error('Packaged Electron runtime is missing')

const cli = join(appRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const hostModule = join(appRoot, 'dist/main/dsh-host.js')
const profileModule = join(appRoot, 'dist/main/dsh-profile.js')
const assessmentModule = join(appRoot, 'dist/main/assessments.js')
const plugin = join(appRoot, 'dist/plugin/index.js')
const temporary = mkdtempSync(join(tmpdir(), 'agenthr-packaged-runtime-'))

function run(args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 10_000_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: temporary },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged runtime check failed: ${result.error?.message ?? result.stderr?.slice(-600) ?? result.status}`)
  }
  return result.stdout
}

try {
  const inspect = [
    'const host = await import(process.argv[1]);',
    'const plugin = await import(process.argv[2]);',
    'const profile = await import(process.argv[3]);',
    'const assessments = await import(process.argv[6]);',
    'if (host.resolveDshCli() !== process.argv[4] || plugin.name !== "agenthr-browser-tools") process.exit(1);',
    'profile.prepareDshProfile(process.argv[5], process.argv[2]);',
    'const store = new assessments.AssessmentStore(process.argv[5]);',
    'if (store.list().length !== 0) process.exit(1);',
    'store.close();',
  ].join(' ')
  run(['--input-type=module', '-e', inspect, pathToFileURL(hostModule).href, pathToFileURL(plugin).href, pathToFileURL(profileModule).href, cli, temporary, pathToFileURL(assessmentModule).href])
  const version = run([cli, '--version']).trim()
  if (!/^\d+\.\d+\.\d+/u.test(version)) throw new Error('Packaged DSH version is invalid')
  const patch = join(temporary, 'agenthr.cordis.patch.yml')
  const config = run([cli, '--profile', 'web', '--patch', patch, '--dump-config'])
  if (!config.includes('agenthr-browser-tools') || !config.includes('default: agenthr') || !config.includes('includeShippedRoot: false')) {
    throw new Error('Packaged DSH did not load the isolated AgentHR preset and plugin')
  }
  process.stdout.write(`Packaged DSH ${version}, AgentHR plugin, and SQLite verified without starting the app.\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
