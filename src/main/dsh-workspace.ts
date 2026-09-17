import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Seed DSH's documented workspace store while its Host is stopped. */
export function bindDshWorkspace(dshHome: string, selectedPath: string): void {
  const path = realpathSync(selectedPath)
  const storageDir = join(dshHome, 'storages')
  const storagePath = join(storageDir, 'workspace.json')
  mkdirSync(storageDir, { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  let value: any = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  }
  if (existsSync(storagePath)) {
    try { value = JSON.parse(readFileSync(storagePath, 'utf8')) } catch { throw new Error('DSH 工作目录配置损坏，无法安全绑定') }
  }
  if (value?.unit?.name !== 'workspace' || value?.unit?.version !== 2 || !value.global || !value.tables?.workspaces) {
    throw new Error('DSH 工作目录配置版本不受支持')
  }
  const records = value.tables.workspaces as Record<string, any>
  let workspaceId = Object.keys(records).find(id => records[id]?.path === path)
  if (!workspaceId) {
    workspaceId = randomUUID()
    records[workspaceId] = { path, title: basename(path) || path, sessionIds: [], createdAt: now, updatedAt: now }
  } else {
    records[workspaceId].title = basename(path) || path
    records[workspaceId].updatedAt = now
  }
  const ids = Array.isArray(value.global.workspaceIds) ? value.global.workspaceIds.filter((id: unknown) => typeof id === 'string' && id !== workspaceId) : []
  value.global.workspaceIds = [workspaceId, ...ids]
  value.global.initialized = true
  const temporary = `${storagePath}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, storagePath)
}
