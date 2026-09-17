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
