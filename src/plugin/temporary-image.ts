import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'

const LEASE_VERSION = 1
const LEASE_TTL_MS = 15 * 60 * 1000
const SHA256 = /^[0-9a-f]{64}$/u
const MANAGER = Symbol.for('agenthr.temporary-image-manager.v1')

interface LeaseRecord {
  version: typeof LEASE_VERSION
  attachmentId: string
  variants: string[]
  createdAt: string
  expiresAt: string
}

interface MutableAttachmentStore extends AttachmentStore {
  [MANAGER]?: TemporaryImageManager
  readImageRequest: AttachmentStore['readImageRequest']
}

export interface PreparedTemporaryImage {
  data: Buffer
  ref: ImageAttachmentRef
}

export interface TemporaryImageLease {
  cleanup(): Promise<void>
}

function attachmentHash(attachmentId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(attachmentId)
  if (!match) throw new Error('临时图片附件 ID 无效')
  return match[1]
}

function variantHash(variantId: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(variantId)
  if (!match) throw new Error('临时图片变体 ID 无效')
  return match[1]
}

function objectPath(root: string, attachmentId: string): string {
  const hash = attachmentHash(attachmentId)
  return join(root, 'objects', hash.slice(0, 2), hash)
}

function requestImagePath(root: string, variantId: string): string {
  const hash = variantHash(variantId)
  return join(root, 'request-images', hash.slice(0, 2), hash)
}

function leasePath(root: string, attachmentId: string): string {
  return join(root, 'agenthr-temporary', `${attachmentHash(attachmentId)}.json`)
}

function isWithin(path: string, parent: string): boolean {
  const normalizedPath = resolve(path)
  const normalizedParent = resolve(parent)
  return normalizedPath.startsWith(`${normalizedParent}${sep}`)
}

async function writeLease(root: string, record: LeaseRecord): Promise<void> {
  const path = leasePath(root, record.attachmentId)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

async function pruneEmptyParent(path: string, expectedParent: string): Promise<void> {
  const parent = dirname(path)
  if (dirname(parent) !== expectedParent) return
  await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
  })
}

async function removeRecord(root: string, record: LeaseRecord): Promise<void> {
  const objectsRoot = join(root, 'objects')
  const requestsRoot = join(root, 'request-images')
  const source = objectPath(root, record.attachmentId)
  const variants = record.variants.map(id => requestImagePath(root, id))
  if (!isWithin(source, objectsRoot) || variants.some(path => !isWithin(path, requestsRoot))) {
    throw new Error('拒绝清理附件根目录之外的路径')
  }
  const failures: unknown[] = []
  for (const path of [...variants, source]) {
    try {
      await rm(path, { force: true })
      await pruneEmptyParent(path, path === source ? objectsRoot : requestsRoot)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, '临时截图物理删除失败')
  await rm(leasePath(root, record.attachmentId), { force: true })
}

function parseRecord(value: unknown): LeaseRecord {
  if (!value || typeof value !== 'object') throw new Error('临时图片租约格式无效')
  const record = value as Partial<LeaseRecord>
  attachmentHash(String(record.attachmentId))
  if (record.version !== LEASE_VERSION || !Array.isArray(record.variants)
    || record.variants.some(id => typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(id))
    || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new Error('临时图片租约格式无效')
  }
  return record as LeaseRecord
}

export class TemporaryImageManager {
  private readonly root = resolve(resolveDshHome(), 'attachments', 'v1')
  private readonly active = new Map<string, LeaseRecord>()

  constructor(private readonly store: AttachmentStore) {
    const mutable = store as MutableAttachmentStore
    const original = store.readImageRequest.bind(store)
    mutable.readImageRequest = async (ref, policy, signal): Promise<RequestImageAttachment> => {
      const result = await original(ref, policy, signal)
      const record = this.active.get(String(ref.attachmentId))
      if (record && !record.variants.includes(String(result.variantId))) {
        record.variants.push(String(result.variantId))
        await writeLease(this.root, record)
      }
      return result
    }
  }

  async begin(ref: ImageAttachmentRef): Promise<TemporaryImageLease> {
    const attachmentId = String(ref.attachmentId)
    const expected = objectPath(this.root, attachmentId)
    const actual = this.store.imageHostPath(ref)
    if (!actual || resolve(actual) !== resolve(expected)) {
      throw new Error('当前附件后端不支持可验证的临时图片物理删除')
    }
    const now = Date.now()
    const record: LeaseRecord = {
      version: LEASE_VERSION,
      attachmentId,
      variants: [],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
    }
    this.active.set(attachmentId, record)
    await writeLease(this.root, record)
    let cleaned = false
    return {
      cleanup: async () => {
        if (cleaned) return
        try {
          await removeRecord(this.root, record)
          cleaned = true
        } catch (error) {
          record.expiresAt = new Date().toISOString()
          await writeLease(this.root, record).catch(() => {})
          throw error
        } finally {
          this.active.delete(attachmentId)
        }
      },
    }
  }

  async sweepExpired(now = Date.now()): Promise<number> {
    const directory = join(this.root, 'agenthr-temporary')
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !SHA256.test(entry.name.slice(0, -5))) continue
      const path = join(directory, entry.name)
      let record: LeaseRecord
      try {
        record = parseRecord(JSON.parse(await readFile(path, 'utf8')))
      } catch {
        await rm(path, { force: true })
        continue
      }
      if (this.active.has(record.attachmentId) || Date.parse(record.expiresAt) > now) continue
      await removeRecord(this.root, record)
      removed += 1
    }
    return removed
  }
}

export function getTemporaryImageManager(store: AttachmentStore): TemporaryImageManager {
  const mutable = store as MutableAttachmentStore
  if (mutable[MANAGER]) return mutable[MANAGER]
  const manager = new TemporaryImageManager(store)
  Object.defineProperty(mutable, MANAGER, { value: manager, configurable: false, enumerable: false })
  return manager
}

export async function prepareTemporaryPng(source: Buffer): Promise<PreparedTemporaryImage> {
  const metadata = await sharp(source).metadata()
  if (!metadata.width || !metadata.height) throw new Error('诊断截图尺寸无效')
  const markerWidth = Math.min(8, metadata.width)
  const marker = randomBytes(markerWidth * 4)
  for (let offset = 3; offset < marker.length; offset += 4) marker[offset] = 255
  const data = await sharp(source)
    .composite([{ input: marker, raw: { width: markerWidth, height: 1, channels: 4 }, left: metadata.width - markerWidth, top: metadata.height - 1 }])
    .png({ compressionLevel: 9 })
    .toBuffer()
  const normalized = await sharp(data).metadata()
  if (!normalized.width || !normalized.height) throw new Error('临时诊断图片生成失败')
  const digest = createHash('sha256').update(data).digest('hex')
  return {
    data,
    ref: {
      attachmentId: `sha256:${digest}` as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: normalized.width,
      height: normalized.height,
      name: 'agenthr-temporary-visual-diagnosis.png',
    },
  }
}
