import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { GridFSBucket, MongoClient } from 'mongodb'
import type { JobProgress } from '@shared/api'
import type { GridFsFile } from '@shared/gridfsApi'
import { GRIDFS_PREVIEW_LIMIT } from '@shared/gridfsApi'
import { parseUri } from '@shared/connection'
import { ConnectionManager } from '../src/main/mongo/manager'
import { GridFs, mimeOf, safeFileName } from '../src/main/gridfs/gridfs'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let gfs: GridFs
let conn: string
let dir: string
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

async function done(jobId: string | Promise<string>): Promise<JobProgress> {
  const f = await wait(await jobId)
  expect(f.state, f.error).toBe('done')
  return f
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

async function put(bucket: string, name: string, data: Buffer | string, metadata?: Record<string, unknown>): Promise<unknown> {
  const b = new GridFSBucket(client.db('files'), { bucketName: bucket })
  const up = b.openUploadStream(name, { metadata })
  await new Promise<void>((resolve, reject) => {
    up.once('finish', () => resolve())
    up.once('error', reject)
    up.end(typeof data === 'string' ? Buffer.from(data) : data)
  })
  return up.id
}

const list = async (bucket = 'fs', search = '', field: 'filename' | 'length' | 'uploadDate' | 'contentType' = 'filename', dir: 1 | -1 = 1, skip = 0, limit = 50): Promise<{ files: GridFsFile[]; total: number }> =>
  gfs.list(conn, 'files', bucket, { search, sort: { field, dir }, skip, limit })

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  mgr = new ConnectionManager()
  conn = (await mgr.connect(parseUri(server.getUri()))).connId
  gfs = new GridFs(mgr, (p) => {
    if (p.state === 'running') return
    finals.set(p.jobId, p)
    waiters.get(p.jobId)?.(p)
  })
  dir = await mkdtemp(join(tmpdir(), 'mg-gridfs-'))
  await put('fs', 'readme.txt', 'hello gridfs\nline 2', { contentType: 'text/plain', owner: 'ann' })
  await put('fs', 'pixel.png', PNG, { contentType: 'image/png' })
  await put('fs', 'blob.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  await put('images', 'a.png', PNG)
  await client.db('files').collection('lonely.files').insertOne({ x: 1 })
})

afterAll(async () => {
  gfs?.cancelAll()
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('buckets', () => {
  it('detects files / chunks pairs', async () => {
    const b = await gfs.buckets(conn, 'files')
    expect(b.map((x) => x.name)).toEqual(['fs', 'images'])
    expect(b[0].files).toBe(3)
  })
})

describe('listing', () => {
  it('lists, sorts, searches and pages', async () => {
    const all = await list()
    expect(all.total).toBe(3)
    expect(all.files.map((f) => f.filename)).toEqual(['blob.bin', 'pixel.png', 'readme.txt'])
    expect(all.files[2]).toMatchObject({ length: 19, contentType: 'text/plain', metadata: { owner: 'ann' } })
    expect((await list('fs', '', 'length', -1)).files[0].filename).toBe('pixel.png')
    const found = await list('fs', 'READ')
    expect(found.total).toBe(1)
    expect(found.files[0].filename).toBe('readme.txt')
    const page = await list('fs', '', 'filename', 1, 1, 1)
    expect(page.files.map((f) => f.filename)).toEqual(['pixel.png'])
    expect(page.total).toBe(3)
    expect((await list('fs', 'a.b(c')).total).toBe(0)
  })
})

describe('upload & download', () => {
  it('uploads with metadata and detected content type, then downloads the same bytes', async () => {
    const src = join(dir, 'report.csv')
    const body = Array.from({ length: 5000 }, (_, i) => `${i},row ${i}`).join('\n')
    await writeFile(src, body)
    const f = await done(gfs.upload(conn, 'files', 'docs', [src], { metadata: { tags: ['q1'] } }))
    expect(f.done).toBe(Buffer.byteLength(body))
    const files = (await list('docs')).files
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ filename: 'report.csv', contentType: 'text/csv', metadata: { tags: ['q1'], contentType: 'text/csv' } })

    const out = join(dir, 'out.csv')
    await done(gfs.download(conn, 'files', 'docs', [files[0]._id], { file: out }))
    expect(await readFile(out, 'utf8')).toBe(body)
  })

  it('renames a single upload and downloads several files into a folder with unique names', async () => {
    const src = join(dir, 'x.txt')
    await writeFile(src, 'one')
    await done(gfs.upload(conn, 'files', 'dup', [src], { filename: 'same.txt', contentType: 'text/x-custom' }))
    await writeFile(src, 'two')
    await done(gfs.upload(conn, 'files', 'dup', [src], { filename: 'same.txt' }))
    const files = (await list('dup', '', 'uploadDate', 1)).files
    expect(files.map((f) => f.filename)).toEqual(['same.txt', 'same.txt'])
    expect(files[0].contentType).toBe('text/x-custom')
    const folder = join(dir, 'many')
    await rm(folder, { recursive: true, force: true })
    await (await import('fs/promises')).mkdir(folder)
    await done(
      gfs.download(
        conn,
        'files',
        'dup',
        files.map((f) => f._id),
        { folder }
      )
    )
    const names = (await readdir(folder)).sort()
    expect(names).toEqual(['same (2).txt', 'same.txt'])
    expect(await readFile(join(folder, 'same.txt'), 'utf8')).toBe('one')
    expect(await readFile(join(folder, 'same (2).txt'), 'utf8')).toBe('two')
  })

  it('refuses a single target file for several files', () => {
    expect(() => gfs.download(conn, 'files', 'fs', [1, 2], { file: join(dir, 'x') })).toThrow(/folder/)
  })
})

describe('cancel', () => {
  it('stops a download without leaving a file', async () => {
    const id = await put('large', 'large.bin', Buffer.alloc(12 * 1024 * 1024, 7))
    const out = join(dir, 'large.bin')
    const job = gfs.download(conn, 'files', 'large', [id], { file: out })
    gfs.cancel(job)
    const f = await wait(job)
    expect(f.state).toBe('cancelled')
    await expect(readFile(out)).rejects.toThrow()
  })
})

describe('preview', () => {
  it('returns text, images and binary markers', async () => {
    const files = (await list()).files
    const by = (n: string): GridFsFile => files.find((f) => f.filename === n)!
    const text = await gfs.preview(conn, 'files', 'fs', by('readme.txt')._id)
    expect(text).toMatchObject({ kind: 'text', data: 'hello gridfs\nline 2', truncated: false })
    const img = await gfs.preview(conn, 'files', 'fs', by('pixel.png')._id)
    expect(img.kind).toBe('image')
    expect(Buffer.from(img.data!, 'base64').equals(PNG)).toBe(true)
    const bin = await gfs.preview(conn, 'files', 'fs', by('blob.bin')._id)
    expect(bin).toMatchObject({ kind: 'binary', mime: 'application/octet-stream' })
  })

  it('truncates large text at the preview limit', async () => {
    const body = 'abcdefgh'.repeat(GRIDFS_PREVIEW_LIMIT / 8 + 500)
    const id = await put('big', 'big.log', body)
    const p = await gfs.preview(conn, 'files', 'big', id)
    expect(p.kind).toBe('text')
    expect(p.truncated).toBe(true)
    expect(p.data!.length).toBe(GRIDFS_PREVIEW_LIMIT)
    expect(p.length).toBe(body.length)
  })
})

describe('edit & delete', () => {
  it('renames, sets metadata and deletes files with their chunks', async () => {
    const id = await put('edit', 'old.txt', 'data')
    await gfs.rename(conn, 'files', 'edit', id, 'new.txt')
    await gfs.setMetadata(conn, 'files', 'edit', id, { k: 1 })
    const f = await gfs.file(conn, 'files', 'edit', id)
    expect(f?.filename).toBe('new.txt')
    expect(Number(f?.metadata?.k)).toBe(1)
    await gfs.setMetadata(conn, 'files', 'edit', id, null)
    expect((await gfs.file(conn, 'files', 'edit', id))?.metadata).toBeUndefined()
    expect(await gfs.delete(conn, 'files', 'edit', [id])).toBe(1)
    expect(await gfs.file(conn, 'files', 'edit', id)).toBeNull()
    expect(await client.db('files').collection('edit.chunks').countDocuments()).toBe(0)
    await expect(gfs.rename(conn, 'files', 'edit', id, 'x')).rejects.toThrow()
  })
})

describe('mimeOf', () => {
  it('maps extensions', () => {
    expect(mimeOf('a.JPG')).toBe('image/jpeg')
    expect(mimeOf('a.unknown')).toBe('application/octet-stream')
  })
})

describe('safeFileName', () => {
  it('turns stored names into one portable path segment', () => {
    expect(safeFileName('images/2024/a.png')).toBe('images_2024_a.png')
    expect(safeFileName('..\\..\\evil.txt')).toBe('.._.._evil.txt')
    expect(safeFileName('..')).toBe('file')
    expect(safeFileName('tab\there\n.txt')).toBe('tab_here_.txt')
    // Windows drops trailing dots / spaces and maps device names to devices.
    expect(safeFileName('report. ')).toBe('report')
    expect(safeFileName('NUL.txt')).toBe('_NUL.txt')
    expect(safeFileName('com1')).toBe('_com1')
    expect(safeFileName('console.log')).toBe('console.log')
    expect(safeFileName('')).toBe('file')
  })
})
