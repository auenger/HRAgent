import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface AgentHrWorkspace {
  path: string
  name: string
}

export interface WorkspaceFile {
  path: string
  name: string
  size: number
  updatedAt: string
  previewable: boolean
  content: string
}

export interface WorkspaceTreeEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size: number
  updatedAt: string
  previewable: boolean
}

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.xml'])
const SKIP_DIRECTORIES = new Set(['.git', '.svn', 'node_modules', 'bower_components', 'vendor', 'venv', '.venv', '__pycache__', 'Pods', '.pnpm', '.gradle', '.next', '.cache'])

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, content, { mode: 0o600 })
  renameSync(temporary, path)
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error('工作目录必须是绝对路径')
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error('工作目录不是文件夹')
  return canonical
}

function detectDshWorkspace(userData: string): string | undefined {
  const storage = join(userData, 'dsh', 'storages', 'workspace.json')
  if (!existsSync(storage)) return undefined
  try {
    const value = JSON.parse(readFileSync(storage, 'utf8')) as { global?: { workspaceIds?: unknown }; tables?: { workspaces?: Record<string, { path?: unknown }> } }
    const ids = Array.isArray(value.global?.workspaceIds) ? value.global.workspaceIds : []
    for (const id of ids) {
      if (typeof id !== 'string') continue
      const path = value.tables?.workspaces?.[id]?.path
      if (typeof path === 'string' && existsSync(path)) return canonicalDirectory(path)
    }
  } catch { /* fall through to the app cwd */ }
  return undefined
}

/** Owns the single working directory shared by AgentHR, DSH and downloaded artifacts. */
export class WorkspaceStore {
  private readonly configPath: string
  private workspace: AgentHrWorkspace
  private watcher?: FSWatcher
  private watchTimer?: ReturnType<typeof setTimeout>
  private readonly changeListeners = new Set<() => void>()

  constructor(private readonly userData: string, fallback = process.cwd()) {
    this.configPath = join(userData, 'agenthr-workspace.json')
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    let selected: string | undefined
    if (existsSync(this.configPath)) {
      try {
        const value = JSON.parse(readFileSync(this.configPath, 'utf8')) as { path?: unknown }
        if (typeof value.path === 'string' && existsSync(value.path)) selected = canonicalDirectory(value.path)
      } catch { /* recover from an unavailable previous directory */ }
    }
    selected ??= detectDshWorkspace(userData)
    selected ??= canonicalDirectory(fallback)
    this.workspace = { path: selected, name: basename(selected) || selected }
    this.persist()
  }

  get(): AgentHrWorkspace { return { ...this.workspace } }

  set(path: string): AgentHrWorkspace {
    const selected = canonicalDirectory(path)
    this.workspace = { path: selected, name: basename(selected) || selected }
    this.persist()
    this.restartWatcher()
    return this.get()
  }

  watchChanges(listener: () => void): () => void {
    this.changeListeners.add(listener)
    this.restartWatcher()
    return () => {
      this.changeListeners.delete(listener)
      if (this.changeListeners.size === 0) this.stopWatcher()
    }
  }

  private restartWatcher(): void {
    this.stopWatcher()
    if (this.changeListeners.size === 0) return
    const changed = (): void => {
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => {
        this.watchTimer = undefined
        for (const listener of this.changeListeners) listener()
      }, 180)
    }
    try {
      this.watcher = watch(this.workspace.path, { recursive: true, persistent: false }, changed)
    } catch {
      this.watcher = watch(this.workspace.path, { persistent: false }, changed)
    }
  }

  private stopWatcher(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = undefined
    this.watcher?.close()
    this.watcher = undefined
  }

  private persist(): void {
    atomicWrite(this.configPath, `${JSON.stringify({ version: 1, path: this.workspace.path }, null, 2)}\n`)
  }

  resolveInside(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('工作文件路径无效')
    const target = resolve(this.workspace.path, relativePath)
    const child = relative(this.workspace.path, target)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('工作文件必须位于工作目录中')
    return target
  }

  private directoryInside(relativePath: string): string {
    if (!relativePath) return this.workspace.path
    return this.resolveInside(relativePath)
  }

  listDirectory(relativePath = ''): WorkspaceTreeEntry[] {
    const directory = this.directoryInside(relativePath)
    if (!statSync(directory).isDirectory()) throw new Error('工作目录节点不是文件夹')
    const entries: WorkspaceTreeEntry[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name) || (!entry.isDirectory() && !entry.isFile())) continue
      const absolute = join(directory, entry.name)
      const info = statSync(absolute)
      const path = relative(this.workspace.path, absolute)
      const extension = extname(entry.name).toLowerCase()
      entries.push({
        path, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', size: entry.isFile() ? info.size : 0,
        updatedAt: info.mtime.toISOString(), previewable: entry.isFile() && TEXT_EXTENSIONS.has(extension) && info.size <= 1024 * 1024,
      })
    }
    return entries
  }

  readFile(relativePath: string): WorkspaceFile {
    const absolute = this.resolveInside(relativePath)
    const info = statSync(absolute)
    if (!info.isFile()) throw new Error('工作目录节点不是文件')
    const name = basename(absolute)
    const previewable = TEXT_EXTENSIONS.has(extname(name).toLowerCase()) && info.size <= 1024 * 1024
    return { path: relative(this.workspace.path, absolute), name, size: info.size, updatedAt: info.mtime.toISOString(), previewable,
      content: previewable ? readFileSync(absolute, 'utf8') : '' }
  }

  importFiles(paths: string[]): WorkspaceFile[] {
    const destination = this.resolveInside('imports')
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const source of paths) {
      const info = statSync(source)
      if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('单个导入文件不能超过 50 MB')
      const safeName = basename(source).replace(/[\\/:*?"<>|]/gu, '_')
      let target = join(destination, safeName)
      const extension = extname(safeName)
      const stem = basename(safeName, extension)
      for (let index = 2; existsSync(target); index++) target = join(destination, `${stem}-${index}${extension}`)
      copyFileSync(source, target)
    }
    return this.listFiles()
  }

  createDownloadTarget(platform: 'boss' | 'liepin', fileName: string): string {
    const destination = this.resolveInside(join('downloads', platform))
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    const safeName = basename(fileName).replace(/[\\/:*?"<>|]/gu, '_').slice(0, 180) || 'attachment'
    const extension = extname(safeName)
    const stem = basename(safeName, extension)
    let target = join(destination, safeName)
    for (let index = 2; existsSync(target); index++) target = join(destination, `${stem}-${index}${extension}`)
    return target
  }

  writeTextArtifact(relativePath: string, content: string): WorkspaceFile {
    if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) throw new Error('单个工作文件不能超过 5 MB')
    const target = this.resolveInside(relativePath)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const file = this.listFiles().find(candidate => candidate.path === relativePath)
    if (!file) throw new Error('工作文件保存后无法读取')
    return file
  }

  listFiles(limit = 200): WorkspaceFile[] {
    const files: WorkspaceFile[] = []
    const walk = (directory: string, depth: number): void => {
      if (depth > 5 || files.length >= limit) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= limit || entry.name.startsWith('.')) continue
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) walk(absolute, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const info = statSync(absolute)
        const previewable = TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) && info.size <= 1024 * 1024
        files.push({
          path: relative(this.workspace.path, absolute), name: entry.name, size: info.size,
          updatedAt: info.mtime.toISOString(), previewable,
          content: previewable ? readFileSync(absolute, 'utf8') : '',
        })
      }
    }
    walk(this.workspace.path, 0)
    return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }
}
