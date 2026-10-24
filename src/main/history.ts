import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { HistoryEntry, HistoryFilter, QueryPayload, SavedQueryEntry } from '@shared/api'
import { clampHistoryLimit, HISTORY_LIMIT_DEFAULT } from '@shared/settings'

/** Default number of history entries kept (Settings → Workspace → Query history). */
export const HISTORY_CAP = HISTORY_LIMIT_DEFAULT
export const HISTORY_DEBOUNCE_MS = 500

type NewHistory = Omit<HistoryEntry, 'id' | 'at'>
type SaveInput = Omit<SavedQueryEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
type StoredHistory = Omit<HistoryEntry, 'at'> & { at: string }
type StoredSaved = Omit<SavedQueryEntry, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }

const live = new Set<QueryLibrary>()

/** Synchronously write pending changes of every library (call on app quit). */
export function flushSync(): void {
  for (const l of live) l.flushSync()
}

/** A JSON file written atomically (tmp + rename); writes are synchronous, so they never interleave. */
class JsonFile<T> {
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly path: string,
    private snapshot: () => T[]
  ) {}

  /** Items of the file; a corrupt file is kept as `.bak` and treated as empty. */
  read(): unknown[] {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    try {
      const raw = JSON.parse(text) as unknown
      const items = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items
      if (Array.isArray(items)) return items
      throw new Error('Unexpected file format')
    } catch {
      try {
        copyFileSync(this.path, `${this.path}.bak`)
      } catch {
        // Nothing to back up.
      }
      return []
    }
  }

  /** Mark as changed and write now, or after `delay` ms of quiet. */
  changed(delay = 0): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!delay) return this.flushSync()
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushSync()
    }, delay)
    this.timer.unref?.()
  }

  flushSync(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty) return
    const tmp = `${this.path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, items: this.snapshot() }), 'utf8')
      renameSync(tmp, this.path)
      this.dirty = false
    } catch (e) {
      console.error(`Could not write ${this.path}:`, e)
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function normPayload(p: unknown): QueryPayload | null {
  const o = p as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  if (o.kind === 'aggregate') return { kind: 'aggregate', pipeline: str(o.pipeline) }
  if (o.kind === 'find') {
    const out: Extract<QueryPayload, { kind: 'find' }> = { kind: 'find', query: str(o.query), projection: str(o.projection), sort: str(o.sort), skip: str(o.skip), limit: str(o.limit) }
    // Kept even when empty: '' means "run without collation", missing (older entries) means "keep the tab's".
    if (typeof o.collation === 'string') out.collation = o.collation
    return out
  }
  return null
}

/** Stable key of a payload for duplicate detection (whitespace at the ends ignored). */
export function payloadKey(p: QueryPayload): string {
  return p.kind === 'aggregate'
    ? JSON.stringify(['a', p.pipeline.trim()])
    : JSON.stringify(['f', p.query.trim(), p.projection.trim(), p.sort.trim(), p.skip.trim(), p.limit.trim(), ...(p.collation?.trim() ? [p.collation.trim()] : [])])
}

/** All searchable text of a payload. */
export function payloadText(p: QueryPayload): string {
  return p.kind === 'aggregate' ? p.pipeline : [p.query, p.projection, p.sort, p.skip, p.limit, p.collation ?? ''].join('\n')
}

const toDate = (v: unknown): Date => {
  const d = new Date(typeof v === 'string' || typeof v === 'number' ? v : (v as Date))
  return Number.isNaN(d.getTime()) ? new Date(0) : d
}

const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function reviveHistory(x: unknown): HistoryEntry | null {
  const o = x as Record<string, unknown> | null
  const payload = normPayload(o?.payload)
  if (!o || typeof o.id !== 'string' || !payload) return null
  return {
    id: o.id,
    at: toDate(o.at),
    configId: str(o.configId),
    connName: str(o.connName),
    db: str(o.db),
    coll: str(o.coll),
    payload,
    ms: optNum(o.ms),
    count: optNum(o.count)
  }
}

function reviveSaved(x: unknown): SavedQueryEntry | null {
  const o = x as Record<string, unknown> | null
  const payload = normPayload(o?.payload)
  if (!o || typeof o.id !== 'string' || !payload) return null
  return {
    id: o.id,
    name: str(o.name) || 'Untitled',
    folder: str(o.folder) || undefined,
    configId: str(o.configId) || undefined,
    db: str(o.db),
    coll: str(o.coll),
    payload,
    createdAt: toDate(o.createdAt),
    updatedAt: toDate(o.updatedAt ?? o.createdAt)
  }
}

export function matchesFilter(e: { configId?: string; connName?: string; db: string; coll: string; payload: QueryPayload }, f: HistoryFilter): boolean {
  if (f.configId && e.configId !== f.configId) return false
  if (f.db && e.db !== f.db) return false
  if (f.coll && e.coll !== f.coll) return false
  if (f.kind && e.payload.kind !== f.kind) return false
  const text = f.text?.trim().toLowerCase()
  if (text) {
    const hay = [e.connName ?? '', e.db, e.coll, `${e.db}.${e.coll}`, payloadText(e.payload)].join('\n').toLowerCase()
    if (!hay.includes(text)) return false
  }
  return true
}

const cmp = (a = '', b = ''): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/** Query history and saved queries, persisted as JSON files in the user data folder. */
export class QueryLibrary {
  private history: HistoryEntry[] | null = null
  private saved: SavedQueryEntry[] | null = null
  private historyFile: JsonFile<StoredHistory>
  private savedFile: JsonFile<StoredSaved>
  private cap = HISTORY_CAP

  constructor(dir: string, historyLimit?: number) {
    if (historyLimit !== undefined) this.cap = clampHistoryLimit(historyLimit)
    this.historyFile = new JsonFile(join(dir, 'history.json'), () => this.hist().map((e) => ({ ...e, at: e.at.toISOString() })))
    this.savedFile = new JsonFile(join(dir, 'saved-queries.json'), () =>
      this.sav().map((q) => ({ ...q, createdAt: q.createdAt.toISOString(), updatedAt: q.updatedAt.toISOString() }))
    )
    live.add(this)
  }

  /** Newest first. */
  private hist(): HistoryEntry[] {
    if (!this.history) {
      this.history = this.historyFile
        .read()
        .map(reviveHistory)
        .filter((e): e is HistoryEntry => !!e)
        .sort((a, b) => b.at.getTime() - a.at.getTime())
      // Not trimmed here: the configured limit may arrive after the first read (it comes from the settings
      // file), and trimming early would lose entries. `record` and `setHistoryLimit` enforce it.
    }
    return this.history
  }

  /** Current maximum number of history entries. */
  get historyLimit(): number {
    return this.cap
  }

  /** Change the maximum (clamped to 100–10000); the oldest entries beyond it are removed. Returns how many were removed. */
  setHistoryLimit(n: number): number {
    this.cap = clampHistoryLimit(n)
    // Not loaded yet: the limit is applied when the file is read.
    if (!this.history) return 0
    const removed = Math.max(0, this.history.length - this.cap)
    if (removed) {
      this.history.length = this.cap
      this.historyFile.changed(HISTORY_DEBOUNCE_MS)
    }
    return removed
  }

  private sav(): SavedQueryEntry[] {
    if (!this.saved) this.saved = this.savedFile.read().map(reviveSaved).filter((q): q is SavedQueryEntry => !!q)
    return this.saved
  }

  addHistory(e: NewHistory): void {
    this.record(e)
  }

  /** Add a run; returns the new or collapsed entry. */
  record(e: NewHistory): HistoryEntry {
    const payload = normPayload(e.payload)
    if (!payload) throw new Error('Invalid query payload')
    const list = this.hist()
    const at = new Date()
    const top = list[0]
    let entry: HistoryEntry
    if (top && top.configId === e.configId && top.db === e.db && top.coll === e.coll && payloadKey(top.payload) === payloadKey(payload)) {
      entry = { ...top, at, connName: e.connName || top.connName, payload, ms: e.ms, count: e.count }
      list[0] = entry
    } else {
      entry = { id: randomUUID(), at, configId: e.configId, connName: e.connName, db: e.db, coll: e.coll, payload, ms: e.ms, count: e.count }
      list.unshift(entry)
      if (list.length > this.cap) list.length = this.cap
    }
    this.historyFile.changed(HISTORY_DEBOUNCE_MS)
    return { ...entry }
  }

  listHistory(f: HistoryFilter = {}): HistoryEntry[] {
    const out: HistoryEntry[] = []
    const limit = f.limit && f.limit > 0 ? f.limit : Infinity
    for (const e of this.hist()) {
      if (out.length >= limit) break
      if (matchesFilter(e, f)) out.push({ ...e, at: new Date(e.at) })
    }
    return out
  }

  deleteHistory(ids: string[]): void {
    const drop = new Set(ids)
    const before = this.hist().length
    this.history = this.hist().filter((e) => !drop.has(e.id))
    if (this.history.length !== before) this.historyFile.changed(HISTORY_DEBOUNCE_MS)
  }

  /** Remove every entry matching the filter (its `limit` is ignored); returns how many were removed. */
  clearHistory(f: HistoryFilter = {}): number {
    const before = this.hist().length
    this.history = this.hist().filter((e) => !matchesFilter(e, f))
    const n = before - this.history.length
    if (n) this.historyFile.changed(HISTORY_DEBOUNCE_MS)
    return n
  }

  /** Sorted by folder (unfiled first), then name. */
  listSaved(): SavedQueryEntry[] {
    return this.sav()
      .map((q) => ({ ...q, createdAt: new Date(q.createdAt), updatedAt: new Date(q.updatedAt) }))
      .sort((a, b) => cmp(a.folder, b.folder) || cmp(a.name, b.name))
  }

  /** Create, or update the query with the same id. */
  save(q: SaveInput): SavedQueryEntry {
    const name = q.name?.trim()
    if (!name) throw new Error('A saved query needs a name')
    const payload = normPayload(q.payload)
    if (!payload) throw new Error('Invalid query payload')
    const list = this.sav()
    const now = new Date()
    const fields = { name, folder: q.folder?.trim() || undefined, configId: q.configId || undefined, db: q.db ?? '', coll: q.coll ?? '', payload }
    const i = q.id ? list.findIndex((x) => x.id === q.id) : -1
    let entry: SavedQueryEntry
    if (i >= 0) {
      entry = { ...list[i], ...fields, updatedAt: now }
      list[i] = entry
    } else {
      entry = { id: q.id || randomUUID(), ...fields, createdAt: now, updatedAt: now }
      list.push(entry)
    }
    this.savedFile.changed()
    return { ...entry }
  }

  deleteSaved(id: string): void {
    const before = this.sav().length
    this.saved = this.sav().filter((q) => q.id !== id)
    if (this.saved.length !== before) this.savedFile.changed()
  }

  /** Write pending (debounced) changes now. */
  flushSync(): void {
    this.historyFile.flushSync()
    this.savedFile.flushSync()
  }

  /** Flush and stop tracking this instance. */
  close(): void {
    this.flushSync()
    live.delete(this)
  }
}
