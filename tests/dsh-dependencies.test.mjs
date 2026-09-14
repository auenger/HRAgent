import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('installed DSH packages share the pinned runtime version', () => {
  const expected = JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@deepseek-ai/dsh']
  const scope = 'node_modules/@deepseek-ai'
  const mismatches = []
  for (const name of readdirSync(scope).filter(name => name.startsWith('dsh-'))) {
    const manifest = join(scope, name, 'package.json')
    if (!existsSync(manifest)) continue
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version
    if (version !== expected) mismatches.push(`${name}@${version}`)
  }
  assert.deepEqual(mismatches, [])
})
