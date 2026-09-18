import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bindDshWorkspace } from '../dist/main/dsh-workspace.js'
import { WorkspaceStore } from '../dist/main/workspace-store.js'

test('workspace store keeps imports and downloads inside the selected directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthr-workspace-'))
  const userData = join(root, 'user-data')
  const workspace = join(root, 'work')
  const source = join(root, 'resume.txt')
  mkdirSync(workspace)
  writeFileSync(source, 'candidate resume')
  try {
    const store = new WorkspaceStore(userData, workspace)
    assert.equal(store.get().path, realpathSync(workspace))
    assert.throws(() => store.resolveInside('../outside.txt'), /工作文件必须位于工作目录中/)
    const imported = store.importFiles([source])
    assert.equal(imported.find(file => file.path === 'imports/resume.txt')?.content, 'candidate resume')
    const target = store.createDownloadTarget('boss', '候选人:简历.pdf')
    assert.equal(target, join(realpathSync(workspace), 'downloads', 'boss', '候选人_简历.pdf'))
    assert.equal(existsSync(join(workspace, 'downloads', 'boss')), true)
    const saved = store.writeTextArtifact('candidates/candidate-1/resume.md', '# Resume')
    assert.equal(saved.path, 'candidates/candidate-1/resume.md')
    assert.equal(saved.content, '# Resume')
    mkdirSync(join(workspace, 'node_modules', 'hidden-package'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', 'hidden-package', 'index.js'), 'dependency')
    mkdirSync(join(workspace, '.private'))
    writeFileSync(join(workspace, '.private', 'secret.txt'), 'hidden')
    const rootEntries = store.listDirectory()
    assert.ok(rootEntries.some(entry => entry.kind === 'directory' && entry.name === 'candidates'))
    assert.equal(rootEntries.some(entry => entry.name === 'node_modules'), false)
    assert.ok(rootEntries.some(entry => entry.kind === 'directory' && entry.name === '.private'))
    assert.deepEqual(store.listDirectory('candidates').map(entry => entry.name), ['candidate-1'])
    assert.equal(store.readFile('candidates/candidate-1/resume.md').content, '# Resume')
    assert.throws(() => store.writeTextArtifact('../outside.md', 'no'), /工作文件必须位于工作目录中/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH workspace binding preserves its v2 store and promotes the shared directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthr-dsh-workspace-'))
  const dshHome = join(root, 'dsh')
  const workspace = join(root, 'shared')
  mkdirSync(workspace)
  try {
    bindDshWorkspace(dshHome, workspace)
    const value = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(value.unit, { name: 'workspace', version: 2 })
    const activeId = value.global.workspaceIds[0]
    assert.equal(value.tables.workspaces[activeId].path, realpathSync(workspace))
    bindDshWorkspace(dshHome, workspace)
    const rebound = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    assert.equal(Object.keys(rebound.tables.workspaces).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('workspace change watcher observes files written outside AgentHR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthr-workspace-watch-'))
  const userData = join(root, 'user-data')
  const workspace = join(root, 'work')
  mkdirSync(workspace)
  const store = new WorkspaceStore(userData, workspace)
  let stop = () => {}
  try {
    const changed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('workspace watcher did not observe the write')), 2500)
      stop = store.watchChanges(() => { clearTimeout(timeout); resolve() })
    })
    mkdirSync(join(workspace, 'reports'))
    writeFileSync(join(workspace, 'reports', 'analysis.md'), '# changed externally')
    await changed
    assert.equal(store.listFiles().find(file => file.path === 'reports/analysis.md')?.content, '# changed externally')
  } finally {
    stop()
    rmSync(root, { recursive: true, force: true })
  }
})
