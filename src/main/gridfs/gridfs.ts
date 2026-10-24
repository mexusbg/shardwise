import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { GridFSBucket } from 'mongodb'
import type { Collection, Document, Filter, MongoClient, ObjectId } from 'mongodb'
import type { Doc, JobProgress } from '@shared/api'
import { GRIDFS_PREVIEW_LIMIT } from '@shared/gridfsApi'
import type { GridFsApi, GridFsBucketInfo, GridFsFile, GridFsListRequest, GridFsListResult, GridFsPreview, GridFsUploadOptions } from '@shared/gridfsApi'
import { RAW_TYPES } from '../mongo/ops'
import { plural } from '../sql/job'
import { JobRunner } from '../copy/jobRunner'
import { decodeText, sniffBom } from '../transfer/encoding'

export interface GridFsConnections {
  get(connId: string): MongoClient
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.ini': 'text/plain',
  '.sql': 'application/sql',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/svg+xml', 'image/avif'])
const isTextMime = (m: string): boolean => m.startsWith('text/') || /json|xml|yaml|javascript|sql|csv/.test(m)

const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

/** Plausibly text: no NUL bytes and few control characters in the first 8 KB. */
function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32)) ctrl++
  }
  return ctrl <= n * 0.02
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof (v as { toNumber?: () => number }).toNumber === 'function') return (v as { toNumber: () => number }).toNumber()
  return Number(v ?? 0) || 0
}

function toFile(d: Doc): GridFsFile {
  const metadata = d.metadata && typeof d.metadata === 'object' ? (d.metadata as Doc) : undefined
  const ct = typeof d.contentType === 'string' ? d.contentType : typeof metadata?.contentType === 'string' ? (metadata.contentType as string) : undefined
  const f: GridFsFile = {
    _id: d._id,
    filename: typeof d.filename === 'string' ? d.filename : '',
    length: num(d.length),
    chunkSize: num(d.chunkSize),
    uploadDate: d.uploadDate instanceof Date ? d.uploadDate : new Date(0)
  }
  if (ct) f.contentType = ct
  if (metadata) f.metadata = metadata
  return f
}

/** Counts bytes flowing through a stream. */
function meter(onBytes: (n: number) => void, signal: AbortSignal): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (signal.aborted) return cb(Object.assign(new Error('Cancelled'), { name: 'AbortError' }))
      onBytes(chunk.length)
      cb(null, chunk)
    }
  })
}

/**
 * Linux and macOS limit a file name to 255 UTF-8 bytes (not characters): a Cyrillic letter takes two. Keep room
 * for the " (2)" suffix of duplicates.
 */
const MAX_NAME_BYTES = 200

/** Shorten to at most `max` UTF-8 bytes on a character boundary, keeping a short extension. */
function fitBytes(name: string, max: number): string {
  const size = (s: string): number => Buffer.byteLength(s, 'utf8')
  if (size(name) <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  const chars = [...name.slice(0, name.length - ext.length)]
  let out = ''
  let bytes = size(ext)
  for (const c of chars) {
    const n = size(c)
    if (bytes + n > max) break
    out += c
    bytes += n
  }
  return out + ext
}

/**
 * A stored filename as a single path segment that is valid on every OS: no separators or control characters,
 * no trailing dots / spaces (Windows drops them) and no device names (`nul.txt` would write nowhere).
 */
export function safeFileName(name: string): string {
  let safe = fitBytes(
    // eslint-disable-next-line no-control-regex
    name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'),
    MAX_NAME_BYTES
  ).replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(safe)) safe = `_${safe}`
  return safe || 'file'
}

async function uniquePath(folder: string, name: string, taken: Set<string>): Promise<string> {
  const safe = safeFileName(name)
  const ext = extname(safe)
  const stem = ext ? safe.slice(0, -ext.length) : safe
  for (let i = 1; ; i++) {
    const candidate = join(folder, i === 1 ? safe : `${stem} (${i})${ext}`)
    if (taken.has(candidate.toLowerCase())) continue
    try {
      await fs.access(candidate)
    } catch {
      taken.add(candidate.toLowerCase())
      return candidate
    }
  }
}

export class GridFs {
  private runner: JobRunner

  constructor(
    private mgr: GridFsConnections,
    emit: (p: JobProgress) => void
  ) {
    this.runner = new JobRunner(emit)
  }

  cancel(jobId: string): void {
    this.runner.cancel(jobId)
  }

  cancelAll(): void {
    this.runner.cancelAll()
  }

  private bucket(connId: string, db: string, name: string): GridFSBucket {
    if (!name.trim()) throw new Error('Choose a bucket')
    return new GridFSBucket(this.mgr.get(connId).db(db), { bucketName: name })
  }

  private files(connId: string, db: string, bucket: string): Collection<Document> {
    return this.mgr.get(connId).db(db).collection(`${bucket}.files`)
  }

  async buckets(connId: string, db: string): Promise<GridFsBucketInfo[]> {
    const d = this.mgr.get(connId).db(db)
    const names = new Set((await d.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map((c) => c.name))
    const out: GridFsBucketInfo[] = []
    for (const n of names) {
      if (!n.endsWith('.files')) continue
      const name = n.slice(0, -'.files'.length)
      if (!name || !names.has(`${name}.chunks`)) continue
      const files = await d
        .collection(n)
        .estimatedDocumentCount({ maxTimeMS: 5000 })
        .catch(() => -1)
      out.push({ name, files })
    }
    return out.sort((a, b) => (a.name === 'fs' ? -1 : b.name === 'fs' ? 1 : a.name.localeCompare(b.name)))
  }

  async list(connId: string, db: string, bucket: string, req: GridFsListRequest): Promise<GridFsListResult> {
    const coll = this.files(connId, db, bucket)
    const filter: Doc = req.search.trim() ? { filename: { $regex: escapeRegex(req.search.trim()), $options: 'i' } } : {}
    const field = req.sort.field === 'contentType' ? 'metadata.contentType' : req.sort.field
    const sort: Doc = { [field]: req.sort.dir }
    if (field !== 'uploadDate') sort._id = 1
    const [docs, total] = await Promise.all([
      coll
        .find(filter as Filter<Document>, { ...RAW_TYPES, sort: sort as never, skip: req.skip, limit: req.limit })
        .toArray(),
      req.search.trim() ? coll.countDocuments(filter as Filter<Document>) : coll.estimatedDocumentCount()
    ])
    return { files: docs.map((d) => toFile(d as Doc)), total }
  }

  async file(connId: string, db: string, bucket: string, id: unknown): Promise<GridFsFile | null> {
    const d = await this.files(connId, db, bucket).findOne({ _id: id } as Filter<Document>, RAW_TYPES)
    return d ? toFile(d as Doc) : null
  }

  download(connId: string, db: string, bucket: string, ids: unknown[], target: { file: string } | { folder: string }): string {
    if (!ids.length) throw new Error('No files selected')
    if ('file' in target && ids.length > 1) throw new Error('Choose a folder to download several files')
    const b = this.bucket(connId, db, bucket)
    const title = ids.length === 1 ? `Download from ${bucket}` : `Download ${plural(ids.length, 'file')} from ${bucket}`
    return this.runner.run(title, async (job) => {
      const docs: GridFsFile[] = []
      for (const id of ids) {
        const f = await this.file(connId, db, bucket, id)
        if (!f) throw new Error(`File ${String(id)} no longer exists`)
        docs.push(f)
      }
      const total = docs.reduce((n, f) => n + f.length, 0)
      job.update({ done: 0, total })
      let done = 0
      const taken = new Set<string>()
      for (const f of docs) {
        job.check()
        const path = 'file' in target ? target.file : await uniquePath(target.folder, f.filename || String(f._id), taken)
        job.update({ message: `${f.filename} (${bytes(f.length)})` })
        try {
          await pipeline(
            b.openDownloadStream(f._id as ObjectId),
            meter((n) => job.update({ done: (done += n) }), job.signal),
            createWriteStream(path),
            { signal: job.signal }
          )
        } catch (e) {
          await fs.rm(path, { force: true }).catch(() => {})
          throw e
        }
        job.addLog(`${f.filename} → ${path}`)
      }
      return docs.length === 1 ? `Downloaded ${docs[0].filename} (${bytes(total)})` : `Downloaded ${plural(docs.length, 'file')} (${bytes(total)})`
    })
  }

  async upload(connId: string, db: string, bucket: string, paths: string[], opts: GridFsUploadOptions): Promise<string> {
    if (!paths.length) throw new Error('No files selected')
    const b = this.bucket(connId, db, bucket)
    const stats = await Promise.all(paths.map((p) => fs.stat(p)))
    const total = stats.reduce((n, s) => n + s.size, 0)
    const title = paths.length === 1 ? `Upload ${basename(paths[0])} to ${bucket}` : `Upload ${plural(paths.length, 'file')} to ${bucket}`
    return this.runner.run(title, async (job) => {
      job.update({ done: 0, total })
      let done = 0
      for (let i = 0; i < paths.length; i++) {
        job.check()
        const p = paths[i]
        const name = paths.length === 1 && opts.filename?.trim() ? opts.filename.trim() : basename(p)
        job.update({ message: `${name} (${bytes(stats[i].size)})` })
        const metadata: Doc = { ...(opts.metadata ?? {}) }
        metadata.contentType = opts.contentType?.trim() || (metadata.contentType as string | undefined) || mimeOf(name)
        const up = b.openUploadStream(name, { metadata, chunkSizeBytes: opts.chunkSizeBytes || undefined })
        try {
          await pipeline(createReadStream(p), meter((n) => job.update({ done: (done += n) }), job.signal), up, { signal: job.signal })
        } catch (e) {
          await up.abort().catch(() => {})
          throw e
        }
        job.addLog(`${p} → ${bucket}: ${name} (${String(up.id)})`)
      }
      return paths.length === 1 ? `Uploaded ${basename(paths[0])} (${bytes(total)})` : `Uploaded ${plural(paths.length, 'file')} (${bytes(total)})`
    })
  }

  async delete(connId: string, db: string, bucket: string, ids: unknown[]): Promise<number> {
    const b = this.bucket(connId, db, bucket)
    let n = 0
    for (const id of ids) {
      await b.delete(id as ObjectId)
      n++
    }
    return n
  }

  async rename(connId: string, db: string, bucket: string, id: unknown, filename: string): Promise<void> {
    if (!filename.trim()) throw new Error('Enter a file name')
    await this.bucket(connId, db, bucket).rename(id as ObjectId, filename.trim())
  }

  async setMetadata(connId: string, db: string, bucket: string, id: unknown, metadata: Doc | null): Promise<void> {
    const update = metadata ? { $set: { metadata } } : { $unset: { metadata: '' } }
    const r = await this.files(connId, db, bucket).updateOne({ _id: id } as Filter<Document>, update)
    if (!r.matchedCount) throw new Error('The file no longer exists')
  }

  async preview(connId: string, db: string, bucket: string, id: unknown): Promise<GridFsPreview> {
    const f = await this.file(connId, db, bucket, id)
    if (!f) throw new Error('The file no longer exists')
    const mime = f.contentType || mimeOf(f.filename)
    if (!f.length) return { kind: 'empty', mime, truncated: false, length: 0 }
    const isImage = IMAGE_MIMES.has(mime)
    if (isImage && f.length > GRIDFS_PREVIEW_LIMIT) return { kind: 'binary', mime, truncated: true, length: f.length }
    const end = Math.min(f.length, GRIDFS_PREVIEW_LIMIT)
    const parts: Buffer[] = []
    for await (const chunk of this.bucket(connId, db, bucket).openDownloadStream(f._id as ObjectId, { start: 0, end })) parts.push(chunk as Buffer)
    const buf = Buffer.concat(parts)
    const truncated = f.length > end
    if (isImage) return { kind: 'image', mime, data: buf.toString('base64'), truncated: false, length: f.length }
    const bom = sniffBom(buf)
    if (isTextMime(mime) || (bom && bom !== 'utf-8') || looksLikeText(buf)) {
      // UTF-8 / UTF-16 by BOM, else UTF-8 when valid, else a legacy code page (e.g. windows-1251 text files).
      // A multi-byte character cut at the preview limit is dropped.
      const { text } = decodeText(buf, !truncated)
      return { kind: 'text', mime, data: text, truncated, length: f.length }
    }
    return { kind: 'binary', mime, truncated, length: f.length }
  }
}

type Handlers = { [K in keyof GridFsApi]: (...args: Parameters<GridFsApi[K]>) => Promise<ReturnType<GridFsApi[K]>> | ReturnType<GridFsApi[K]> }

/** IPC handlers for the GridFS browser; spread into the api object. */
export function gridFsHandlers(g: GridFs): Handlers {
  return {
    gridfsBuckets: (connId, db) => g.buckets(connId, db),
    gridfsList: (connId, db, bucket, req) => g.list(connId, db, bucket, req),
    gridfsFile: (connId, db, bucket, id) => g.file(connId, db, bucket, id),
    gridfsDownload: (connId, db, bucket, ids, target) => g.download(connId, db, bucket, ids, target),
    gridfsUpload: (connId, db, bucket, paths, opts) => g.upload(connId, db, bucket, paths, opts),
    gridfsDelete: (connId, db, bucket, ids) => g.delete(connId, db, bucket, ids),
    gridfsRename: (connId, db, bucket, id, filename) => g.rename(connId, db, bucket, id, filename),
    gridfsSetMetadata: (connId, db, bucket, id, metadata) => g.setMetadata(connId, db, bucket, id, metadata),
    gridfsPreview: (connId, db, bucket, id) => g.preview(connId, db, bucket, id),
    gridfsCancel: (jobId) => g.cancel(jobId)
  }
}
