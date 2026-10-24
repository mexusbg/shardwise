import { randomUUID } from 'crypto'
import { promises as fs, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import type { Document, Filter, FindCursor, MongoClient } from 'mongodb'
import { collectPaths } from '@shared/docPaths'
import type { ConnectionConfig } from '@shared/connection'
import type { AppSettings, Doc, ExportRequest, FilePreview, ImportRequest, JobProgress, TextEncoding, ToolsStatus, TransferFormat } from '@shared/api'
import type { EncodingChoice } from './encoding'
import { collationOption, RAW_TYPES } from '../mongo/ops'
import type { PortForward, Tunnel } from '../mongo/sshTunnel'
import { createJsonSink, previewJson, readJsonDocs } from './json'
import { createCsvSink, previewCsv, readCsvDocs } from './csv'
import { createXlsxSink, previewXlsx, readXlsxDocs } from './xlsx'
import { DocWriter, ImportAbort } from './importer'
import type { ChangeRecorders } from '../changes/recorder'
import { peek } from './io'
import type { DocSink, DocSource } from './io'
import {
  archiveNamespaces,
  assertToolsVersion,
  dumpArgs,
  dumpFolderLayout,
  firstHost,
  locateTools,
  parseToolLine,
  queryFileText,
  restoreArgs,
  runTool,
  toolConnection,
  toolPath,
  toolVersion
} from './bsonTools'
import type { LocatedTools } from './bsonTools'
import { downloadTools as fetchTools } from './toolsDownload'

/** What Transfers needs from the connection manager (ConnectionManager satisfies it). */
export interface TransferConnections {
  get(connId: string): MongoClient
  config(connId: string): ConnectionConfig
  tunnelFor(connId: string): Tunnel | undefined
}

/** What Transfers needs from the settings store (Store satisfies it). */
export interface TransferSettings {
  getSettings(): Promise<AppSettings>
}

/** Job id used for the progress events of `downloadTools()`. */
export const DOWNLOAD_JOB_ID = 'download-tools'

const EMIT_INTERVAL_MS = 100
const MAX_LOG_LINES = 500
/** Documents sampled to discover CSV / Excel columns when no fields are given. */
const FIELD_SAMPLE = 1000

const FORMAT_LABELS: Record<TransferFormat, string> = {
  json: 'JSON',
  csv: 'CSV',
  xlsx: 'Excel',
  'bson-folder': 'BSON (mongodump folder)',
  'bson-archive': 'BSON (mongodump archive)'
}

const EXTENSIONS: Partial<Record<TransferFormat, string>> = { json: 'json', csv: 'csv', xlsx: 'xlsx' }

const fmt = (n: number): string => n.toLocaleString('en-US')

/** File-system safe version of a collection name. */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_') || '_'
}

const isAbort = (e: unknown, signal: AbortSignal): boolean => signal.aborted || (e as Error)?.name === 'AbortError'

/** Progress state of one job, emitted at most every 100 ms (plus the final update). */
class Job {
  readonly ctrl = new AbortController()
  done = 0
  total?: number
  message?: string
  private log: string[] = []
  private dropped = 0
  private lastEmit = 0
  private timer: NodeJS.Timeout | null = null
  private finished = false

  constructor(
    readonly id: string,
    readonly title: string,
    private emit: (p: JobProgress) => void
  ) {}

  get signal(): AbortSignal {
    return this.ctrl.signal
  }

  addLog(line: string): void {
    this.log.push(line)
    if (this.log.length > MAX_LOG_LINES) {
      this.log.shift()
      this.dropped++
    }
    this.touch()
  }

  update(p: { done?: number; total?: number; message?: string }): void {
    if (p.done !== undefined) this.done = p.done
    if (p.total !== undefined) this.total = p.total
    if (p.message !== undefined) this.message = p.message
    this.touch()
  }

  private snapshot(state: JobProgress['state'], error?: string): JobProgress {
    const log = this.dropped ? [`… ${fmt(this.dropped)} earlier lines omitted`, ...this.log] : [...this.log]
    const p: JobProgress = { jobId: this.id, title: this.title, done: this.done, state, log }
    if (this.total !== undefined) p.total = this.total
    if (this.message !== undefined) p.message = this.message
    if (error !== undefined) p.error = error
    return p
  }

  touch(): void {
    if (this.finished) return
    const now = Date.now()
    const wait = this.lastEmit + EMIT_INTERVAL_MS - now
    if (wait <= 0) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), wait)
    }
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.finished) return
    this.lastEmit = Date.now()
    this.emit(this.snapshot('running'))
  }

  finish(state: 'done' | 'error' | 'cancelled', error?: string): void {
    if (this.finished) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.finished = true
    this.emit(this.snapshot(state, error))
  }
}

export class Transfers {
  private jobs = new Map<string, Job>()
  private downloading: Promise<string> | null = null
  /** Temporary folders that may hold secrets (tools config); removed synchronously on quit. */
  private tempDirs = new Set<string>()
  private closed = false

  constructor(
    private mgr: TransferConnections,
    private store: TransferSettings,
    private userData: string,
    private emit: (p: JobProgress) => void,
    /** mongodump / mongorestore shipped with the app (extraResources). */
    private bundledToolsDir = '',
    private recorders?: ChangeRecorders
  ) {}

  private get toolsRoot(): string {
    return join(this.userData, 'tools')
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private async locate(): Promise<LocatedTools | null> {
    const settings = await this.store.getSettings()
    return locateTools(settings.toolsPath ?? '', this.toolsRoot, process.env.PATH ?? '', this.bundledToolsDir)
  }

  async toolsStatus(): Promise<ToolsStatus> {
    const t = await this.locate()
    if (!t) return { found: false }
    const version = await toolVersion(t.dir).catch(() => undefined)
    return { found: true, dir: t.dir, version, source: t.source }
  }

  /** Download the official MongoDB Database Tools; progress is emitted under job id `download-tools`. */
  downloadTools(): Promise<string> {
    if (this.downloading) return this.downloading
    const job = new Job(DOWNLOAD_JOB_ID, 'Download MongoDB Database Tools', this.emit)
    this.jobs.set(job.id, job)
    this.downloading = (async () => {
      try {
        const dir = await fetchTools(
          this.toolsRoot,
          (p) => job.update({ done: p.received, total: p.total, message: p.message }),
          job.signal
        )
        job.update({ message: `Installed in ${dir}` })
        job.addLog(`MongoDB Database Tools installed in ${dir}`)
        job.finish('done')
        return dir
      } catch (e) {
        if (isAbort(e, job.signal)) job.finish('cancelled')
        else job.finish('error', (e as Error).message)
        throw e
      } finally {
        this.jobs.delete(job.id)
        this.downloading = null
      }
    })()
    return this.downloading
  }

  private async requireTools(): Promise<{ dir: string; version?: string }> {
    const t = await this.locate()
    if (!t) {
      throw new Error('MongoDB Database Tools (mongodump / mongorestore) were not found. Download them or set their folder in Settings.')
    }
    const version = await toolVersion(t.dir).catch(() => undefined)
    assertToolsVersion(version)
    return { dir: t.dir, version }
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  async preview(format: TransferFormat, source: string, opts: { delimiter?: string; sheet?: string; encoding?: TextEncoding } = {}): Promise<FilePreview> {
    switch (format) {
      case 'json':
        return previewJson(source, 20, opts.encoding)
      case 'csv':
        return previewCsv(source, opts.delimiter ?? ',', 20, opts.encoding)
      case 'xlsx':
        return previewXlsx(source, opts.sheet)
      case 'bson-folder':
        return { columns: [], sample: [], namespaces: (await dumpFolderLayout(source)).namespaces }
      case 'bson-archive':
        return { columns: [], sample: [], namespaces: await archiveNamespaces(source).catch(() => []) }
    }
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  private start(title: string, run: (job: Job) => Promise<string>): string {
    const job = new Job(randomUUID(), title, this.emit)
    this.jobs.set(job.id, job)
    job.update({ message: 'Starting…' })
    void (async () => {
      try {
        const message = await run(job)
        job.update({ message })
        job.finish(job.signal.aborted ? 'cancelled' : 'done')
      } catch (e) {
        if (isAbort(e, job.signal)) {
          job.update({ message: 'Cancelled' })
          job.finish('cancelled')
        } else {
          const msg = (e as Error)?.message || String(e)
          job.update({ message: msg })
          job.finish('error', msg)
        }
      } finally {
        this.jobs.delete(job.id)
      }
    })()
    return job.id
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.ctrl.abort()
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) j.ctrl.abort()
  }

  /** Cancel every job and remove its temporary files synchronously (call on app quit). */
  cleanupSync(): void {
    this.closed = true
    this.cancelAll()
    for (const dir of this.tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
        this.tempDirs.delete(dir)
      } catch {
        // best effort
      }
    }
  }

  /** Run `fn` with a private temporary folder that is always removed afterwards. */
  private async withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'shardwise-'))
    if (this.closed) {
      rmSync(dir, { recursive: true, force: true })
      throw new DOMException('Cancelled', 'AbortError')
    }
    this.tempDirs.add(dir)
    try {
      return await fn(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).then(
        () => this.tempDirs.delete(dir),
        () => {}
      )
    }
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  startExport(req: ExportRequest): string {
    if (!req.collections.length) throw new Error('No collection selected')
    if (!req.target) throw new Error('No target file or folder')
    this.mgr.get(req.connId) // fail fast when not connected
    const what = req.collections.length === 1 ? `${req.db}.${req.collections[0]}` : `${req.db} (${req.collections.length} collections)`
    const title = `Export ${what} → ${FORMAT_LABELS[req.format]}`
    if (req.format === 'bson-folder' || req.format === 'bson-archive') return this.start(title, (job) => this.runDump(job, req))
    return this.start(title, (job) => this.runExport(job, req))
  }

  private queryFor(req: ExportRequest): ExportRequest['query'] | undefined {
    return req.collections.length === 1 ? req.query : undefined
  }

  private async countFor(client: MongoClient, db: string, coll: string, q: ExportRequest['query'] | undefined): Promise<number> {
    const c = client.db(db).collection(coll)
    const filter = (q?.filter ?? {}) as Filter<Document>
    if (!q || (!Object.keys(filter).length && !q.skip && !q.limit)) return c.estimatedDocumentCount()
    return c.countDocuments(filter, { skip: q.skip || undefined, limit: q.limit || undefined, collation: collationOption(q.collation) })
  }

  private async runExport(job: Job, req: ExportRequest): Promise<string> {
    const client = this.mgr.get(req.connId)
    const multi = req.collections.length > 1
    const ext = EXTENSIONS[req.format]!
    if (multi) await fs.mkdir(req.target, { recursive: true })
    else await fs.mkdir(dirname(req.target), { recursive: true })
    const q = this.queryFor(req)
    // Checked before any file is written; matching and sort order follow the query tab's collation.
    const collation = collationOption(q?.collation)

    const totals = await Promise.all(req.collections.map((c) => this.countFor(client, req.db, c, q).catch(() => 0)))
    job.update({ total: totals.reduce((a, b) => a + b, 0), done: 0 })

    let exported = 0
    for (const coll of req.collections) {
      job.signal.throwIfAborted()
      const path = multi ? join(req.target, `${safeFileName(coll)}.${ext}`) : req.target
      job.update({ message: `Exporting ${req.db}.${coll}…` })
      const cursor = client
        .db(req.db)
        .collection(coll)
        .find((q?.filter ?? {}) as Filter<Document>, {
          ...RAW_TYPES,
          bsonRegExp: true,
          projection: q?.projection ?? undefined,
          sort: (q?.sort ?? undefined) as Document | undefined,
          skip: q?.skip || undefined,
          limit: q?.limit || undefined,
          collation
        }) as FindCursor<Doc>
      let n = 0
      let sink: DocSink | null = null
      try {
        const it = cursor[Symbol.asyncIterator]()
        let head: Doc[] = []
        let fields: string[] = []
        if (req.format === 'csv' || req.format === 'xlsx') {
          fields = (req.format === 'csv' ? req.csv?.fields : req.xlsx?.fields) ?? []
          if (!fields.length) {
            head = (await peek(it, FIELD_SAMPLE)).head
            fields = collectPaths(head, true)
            if (!fields.length) fields = ['_id']
          }
        }
        sink = this.createSink(req, path, coll, fields)
        const write = async (doc: Doc): Promise<void> => {
          job.signal.throwIfAborted()
          await sink!.write(doc)
          n++
          job.update({ done: exported + n })
        }
        for (const doc of head) await write(doc)
        for (;;) {
          const r = await it.next()
          if (r.done) break
          await write(r.value)
        }
        await sink.close()
      } catch (e) {
        await sink?.destroy()
        throw e
      } finally {
        await cursor.close().catch(() => {})
      }
      exported += n
      job.addLog(`Exported ${fmt(n)} document${n === 1 ? '' : 's'} from ${req.db}.${coll} to ${path}`)
    }
    job.update({ done: exported, total: exported })
    return `Exported ${fmt(exported)} document${exported === 1 ? '' : 's'}`
  }

  private createSink(req: ExportRequest, path: string, coll: string, fields: string[]): DocSink {
    switch (req.format) {
      case 'json':
        return createJsonSink(path, req.json ?? { flavor: 'relaxed', layout: 'lines', pretty: false })
      case 'csv':
        return createCsvSink(path, { fields, delimiter: req.csv?.delimiter ?? ',', header: req.csv?.header ?? true, bom: !!req.csv?.bom })
      case 'xlsx':
        return createXlsxSink(path, fields, coll)
      default:
        throw new Error(`Unsupported export format ${req.format}`)
    }
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  startImport(req: ImportRequest): string {
    if (!req.source) throw new Error('No source file or folder')
    this.mgr.get(req.connId)
    const bson = req.format === 'bson-folder' || req.format === 'bson-archive'
    if (!bson && (!req.db || !req.collection)) throw new Error('A target database and collection are required')
    const target = bson ? req.db || 'original databases' : `${req.db}.${req.collection}`
    const title = `Import ${basename(req.source)} → ${target}`
    if (bson) return this.start(title, (job) => this.runRestore(job, req))
    return this.start(title, (job) => this.runImport(job, req))
  }

  private openSource(req: ImportRequest, signal: AbortSignal): DocSource & { encoding?: () => EncodingChoice | undefined } {
    switch (req.format) {
      case 'json':
        return readJsonDocs(req.source, signal, req.encoding)
      case 'csv':
        return readCsvDocs(req.source, req.csv?.delimiter ?? ',', req.csv?.columnTypes ?? {}, signal, req.encoding)
      case 'xlsx':
        return readXlsxDocs(req.source, req.xlsx?.sheet, req.xlsx?.columnTypes ?? {}, signal)
      default:
        throw new Error(`Unsupported import format ${req.format}`)
    }
  }

  private async runImport(job: Job, req: ImportRequest): Promise<string> {
    const coll = this.mgr.get(req.connId).db(req.db).collection(req.collection)
    const ns = `${req.db}.${req.collection}`
    const history = req.dropFirst || req.mode === 'upsert' ? (this.recorders?.forConn(req.connId)?.begin(req.db, req.collection, 'import', `Import ${basename(req.source)}`) ?? null) : null
    if (req.dropFirst) {
      const n = history ? await coll.estimatedDocumentCount().catch(() => -1) : -1
      await coll.drop().catch((e: { code?: number; codeName?: string }) => {
        if (e?.code !== 26 && e?.codeName !== 'NamespaceNotFound') throw e
      })
      history?.marker(`Collection dropped before import${n >= 0 ? ` (${n.toLocaleString('en-US')} documents, not recoverable from history)` : ''}`)
      job.addLog(`Dropped ${ns}`)
    }
    const writer = new DocWriter(coll, req.mode, req.stopOnError, (l) => job.addLog(l), req.mode === 'upsert' ? history : null)
    const source = this.openSource(req, job.signal)
    const progress = (): void => {
      const pct = Math.floor(source.progress() * 100)
      job.update({ done: writer.processed, message: `Importing into ${ns}… ${pct}% of the file read` })
    }
    let aborted: string | null = null
    let encodingLogged = !source.encoding
    try {
      for await (const item of source) {
        job.signal.throwIfAborted()
        if (!encodingLogged) {
          encodingLogged = true
          const enc = source.encoding?.()
          if (enc && (enc.note || enc.encoding !== 'utf-8')) job.addLog(enc.note ?? `Reading ${basename(req.source)} as ${enc.encoding}`)
        }
        if (item.error) await writer.recordError(item.error)
        else if (item.doc) await writer.add(item.doc)
        progress()
      }
      await writer.flush()
    } catch (e) {
      if (!(e instanceof ImportAbort)) {
        if (!isAbort(e, job.signal)) throw e
        // Cancelled: keep what was written, report counts.
        job.addLog(`Cancelled after ${fmt(writer.processed)} documents`)
        throw e
      }
      aborted = e.message
    }
    job.update({ done: writer.processed, total: writer.processed })
    const parts = [`${fmt(writer.inserted)} inserted`]
    if (req.mode === 'upsert') parts.push(`${fmt(writer.updated)} replaced`)
    if (writer.failed) parts.push(`${fmt(writer.failed)} failed`)
    const summary = `Imported into ${ns}: ${parts.join(', ')}`
    job.addLog(summary)
    if (aborted) throw new Error(`Stopped on error: ${aborted}`)
    return summary
  }

  // -------------------------------------------------------------------------
  // BSON via mongodump / mongorestore
  // -------------------------------------------------------------------------

  /**
   * Run a tool job with its connection arguments: a temporary --config file (password) and, over SSH, a
   * local port forward. Both are removed when `fn` settles.
   */
  private withToolConn<T>(job: Job, connId: string, version: string | undefined, fn: (args: string[], tmp: string) => Promise<T>): Promise<T> {
    return this.withTempDir(async (tmp) => {
      const cfg = this.mgr.config(connId)
      let fwd: PortForward | undefined
      try {
        // SSH tunnel or proxy bridge: the tools cannot use SOCKS, so they get a local port forward.
        const tunnel = this.mgr.tunnelFor(connId)
        if (cfg.ssh.enabled && !tunnel) throw new Error('The SSH tunnel of this connection is not open')
        if (tunnel) {
          const target = await firstHost(cfg)
          fwd = await tunnel.forwardPort(target.host, target.port)
          const via = tunnel.kind === 'proxy' ? 'proxy' : 'SSH'
          job.addLog(`Using ${via} port forward 127.0.0.1:${fwd.port} → ${target.host}:${target.port} (direct connection to that host only)`)
        }
        job.signal.throwIfAborted()
        const args = await toolConnection(cfg, { dir: tmp, localPort: fwd?.port, toolVersion: version })
        return await fn(args, tmp)
      } finally {
        fwd?.close()
      }
    })
  }

  private async runDump(job: Job, req: ExportRequest): Promise<string> {
    const tools = await this.requireTools()
    const client = this.mgr.get(req.connId)
    const archive = req.format === 'bson-archive'
    const existing = (await client.db(req.db).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray())
      .map((c) => c.name as string)
      .filter((n) => !n.startsWith('system.'))
    const wanted = new Set(req.collections)
    const all = existing.length > 0 && existing.every((c) => wanted.has(c))
    const q = this.queryFor(req)
    const filter = q?.filter && Object.keys(q.filter).length ? q.filter : undefined
    if (q && (q.sort || q.projection || q.skip || q.limit)) {
      job.addLog('Note: mongodump applies only the query filter; sort, projection, skip and limit are ignored.')
    }
    if (filter && collationOption(q?.collation)) {
      job.addLog('Note: mongodump has no collation option; the filter matches strings in binary order (case-sensitive).')
    }

    const totals = await Promise.all(
      req.collections.map((c) => this.countFor(client, req.db, c, filter ? { filter } : undefined).catch(() => 0))
    )
    job.update({ total: totals.reduce((a, b) => a + b, 0), done: 0 })

    if (archive) await fs.mkdir(dirname(req.target), { recursive: true })
    else await fs.mkdir(req.target, { recursive: true })

    return this.withToolConn(job, req.connId, tools.version, async (connArgs, tmp) => {
      let queryFile: string | undefined
      if (filter) {
        queryFile = join(tmp, 'query.json')
        await fs.writeFile(queryFile, queryFileText(filter), { mode: 0o600 })
      }
      const args = [
        ...connArgs,
        ...dumpArgs({ db: req.db, collections: req.collections, all, existing, archive, gzip: !!req.bson?.gzip, target: req.target }, queryFile)
      ]
      const finished = new Map<string, number>()
      const current = new Map<string, number>()
      const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)
      let lastError = ''
      const r = await runTool(toolPath(tools.dir, 'mongodump'), args, {
        signal: job.signal,
        onLine: (line) => {
          const ev = parseToolLine(line)
          switch (ev.kind) {
            case 'progress':
              current.set(ev.ns, ev.done)
              job.update({ done: sum(finished) + sum(current), message: ev.text })
              break
            case 'dumped':
              current.delete(ev.ns)
              finished.set(ev.ns, ev.count)
              job.addLog(`Dumped ${ev.ns} (${fmt(ev.count)} document${ev.count === 1 ? '' : 's'})`)
              job.update({ done: sum(finished) + sum(current), message: ev.text })
              break
            default:
              if (/fail|error/i.test(ev.text)) lastError = ev.text
              job.addLog(ev.text)
          }
        }
      })
      if (r.code !== 0) throw new Error(lastError || `mongodump exited with code ${r.code}`)
      const n = sum(finished)
      job.update({ done: n, total: n })
      return `Dumped ${fmt(n)} document${n === 1 ? '' : 's'} from ${finished.size} collection${finished.size === 1 ? '' : 's'} to ${req.target}`
    })
  }

  private async runRestore(job: Job, req: ImportRequest): Promise<string> {
    const tools = await this.requireTools()
    const archive = req.format === 'bson-archive'
    const gzip = !!req.bson?.gzip
    let namespaces: string[] | undefined
    try {
      namespaces = archive ? await archiveNamespaces(req.source) : (await dumpFolderLayout(req.source)).namespaces
    } catch {
      namespaces = undefined
    }
    if (req.mode === 'upsert') job.addLog('Note: mongorestore only inserts; documents whose _id already exists are reported as failures (use "drop" to replace).')
    const args = await restoreArgs({
      source: req.source,
      archive,
      gzip,
      db: req.db,
      collection: req.collection || undefined,
      nsInclude: req.bson?.nsInclude,
      namespaces,
      drop: req.dropFirst,
      stopOnError: req.stopOnError
    })
    return this.withToolConn(job, req.connId, tools.version, async (connArgs) => {
      let restored = 0
      let failed = 0
      let summary = ''
      let lastError = ''
      const r = await runTool(toolPath(tools.dir, 'mongorestore'), [...connArgs, ...args], {
        signal: job.signal,
        onLine: (line) => {
          const ev = parseToolLine(line)
          switch (ev.kind) {
            case 'bytes':
            case 'progress':
              job.update({ message: ev.text })
              break
            case 'restored':
              restored += ev.count
              failed += ev.failures
              job.addLog(`Restored ${ev.ns} (${fmt(ev.count)} document${ev.count === 1 ? '' : 's'}, ${fmt(ev.failures)} failure${ev.failures === 1 ? '' : 's'})`)
              job.update({ done: restored + failed, message: ev.text })
              break
            case 'summary':
              restored = ev.restored
              failed = ev.failed
              summary = ev.text
              job.update({ done: restored + failed })
              break
            default:
              if (/fail|error/i.test(ev.text)) lastError = ev.text
              job.addLog(ev.text)
          }
        }
      })
      if (r.code !== 0) throw new Error(lastError || `mongorestore exited with code ${r.code}`)
      job.update({ done: restored + failed, total: restored + failed })
      return summary || `Restored ${fmt(restored)} documents${failed ? `, ${fmt(failed)} failed` : ''}`
    })
  }
}
