import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const builder = require.resolve('electron-builder/cli.js')
const electronDist = join(dirname(require.resolve('electron/package.json')), 'dist')
const args = [builder, '--dir', '--publish', 'never', `--config.electronDist=${electronDist}`]

if (process.platform === 'darwin') {
  args.push('--config.forceCodeSigning=false', '--config.mac.identity=null', '--config.mac.notarize=false')
}

const result = spawnSync(process.execPath, args, {
  cwd: join(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
