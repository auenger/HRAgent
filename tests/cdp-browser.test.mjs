import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAccessibilitySnapshot } from '../dist/main/cdp-browser.js'

const property = (name, value) => ({ name, value: { value } })
const node = (nodeId, parentId, role, name, properties = [], value) => ({
  nodeId, ...(parentId ? { parentId } : {}), ignored: false,
  role: { value: role }, name: { value: name }, properties,
  ...(value === undefined ? {} : { value: { value } }),
})

test('accessibility snapshots preserve hierarchy and emit bounded semantic diffs', () => {
  const first = buildAccessibilitySnapshot('main', [
    node('1', undefined, 'RootWebArea', '人才搜索'),
    node('2', '1', 'textbox', '搜索关键词', [property('required', true)], ''),
    node('3', '1', 'button', '搜索', [property('disabled', false)]),
    { nodeId: 'ignored', ignored: true, role: { value: 'generic' }, name: { value: '噪声' } },
  ], 1)
  assert.equal(first.snapshot.mode, 'full')
  assert.deepEqual(first.snapshot.rootIds, ['main:ax:1'])
  assert.equal(first.snapshot.nodes.length, 3)
  assert.equal(first.snapshot.nodes[1].parentId, 'main:ax:1')
  assert.equal(first.snapshot.nodes[1].states.required, true)

  const second = buildAccessibilitySnapshot('main', [
    node('1', undefined, 'RootWebArea', '人才搜索'),
    node('2', '1', 'textbox', '搜索关键词', [property('required', true)], 'Java'),
    node('4', '1', 'status', '找到 12 位候选人'),
  ], 2, first.current)
  assert.equal(second.snapshot.mode, 'diff')
  assert.deepEqual(second.snapshot.added.map(item => item.id), ['main:ax:4'])
  assert.deepEqual(second.snapshot.changed.map(item => [item.id, item.value]), [['main:ax:2', 'Java']])
  assert.deepEqual(second.snapshot.removed, ['main:ax:3'])
})
