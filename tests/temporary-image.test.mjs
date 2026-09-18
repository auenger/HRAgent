import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getTemporaryImageManager, prepareTemporaryPng } from '../dist/plugin/temporary-image.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpH7D8IMMAYAJowE7bwlVOYAAAAASUVORK5CYII=', 'base64')

function paths(home, id) {
  const hash = String(id).slice(7)
  const root = join(home, 'attachments', 'v1')
  return {
    root,
    object: join(root, 'objects', hash.slice(0, 2), hash),
    lease: join(root, 'agenthr-temporary', `${hash}.json`),
  }
}

function fakeStore(home, variantId) {
  return {
    imageHostPath(ref) { return paths(home, ref.attachmentId).object },
    async readImageRequest(ref) {
      const variantHash = variantId.slice(7)
      const variant = join(paths(home, ref.attachmentId).root, 'request-images', variantHash.slice(0, 2), variantHash)
      await mkdir(join(variant, '..'), { recursive: true })
      await writeFile(variant, 'variant')
      return { variantId, attachment: ref, data: new Uint8Array([1]), mediaType: 'image/png', bytes: 1, width: ref.width, height: ref.height, depth: 'uchar', space: 'srgb', hasAlpha: true }
    },
  }
}

test('temporary screenshot preparation makes repeated captures content-unique', async () => {
  const first = await prepareTemporaryPng(PNG)
  const second = await prepareTemporaryPng(PNG)
  assert.notEqual(String(first.ref.attachmentId), String(second.ref.attachmentId))
  assert.equal(first.ref.mediaType, 'image/png')
})

test('temporary image lease physically removes normalized and request-image files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthr-temp-image-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const prepared = await prepareTemporaryPng(PNG)
    const variantId = `sha256:${'b'.repeat(64)}`
    const store = fakeStore(home, variantId)
    const manager = getTemporaryImageManager(store)
    const lease = await manager.begin(prepared.ref)
    const location = paths(home, prepared.ref.attachmentId)
    await mkdir(join(location.object, '..'), { recursive: true })
    await writeFile(location.object, prepared.data)
    await store.readImageRequest(prepared.ref, { maxPixels: 100, maxBytes: 100 })
    const variantHash = variantId.slice(7)
    const variant = join(location.root, 'request-images', variantHash.slice(0, 2), variantHash)
    await access(location.object)
    await access(variant)
    await access(location.lease)

    await lease.cleanup()

    await assert.rejects(access(location.object))
    await assert.rejects(access(variant))
    await assert.rejects(access(location.lease))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TTL sweep removes an expired lease left by an interrupted process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agenthr-temp-image-ttl-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const prepared = await prepareTemporaryPng(PNG)
    const firstStore = fakeStore(home, `sha256:${'c'.repeat(64)}`)
    const lease = await getTemporaryImageManager(firstStore).begin(prepared.ref)
    assert.ok(lease)
    const location = paths(home, prepared.ref.attachmentId)
    await mkdir(join(location.object, '..'), { recursive: true })
    await writeFile(location.object, prepared.data)

    const recoveryStore = fakeStore(home, `sha256:${'d'.repeat(64)}`)
    const removed = await getTemporaryImageManager(recoveryStore).sweepExpired(Date.now() + 16 * 60 * 1000)
    assert.equal(removed, 1)
    await assert.rejects(access(location.object))
    await assert.rejects(access(location.lease))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
