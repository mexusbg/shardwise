import type { UpdateRequest, UpdateResult } from '@shared/api'
import { updateProblem } from '@shared/updateDocuments'
import type { CollationOptions, Document, Filter, MongoClient } from 'mongodb'
import { toCollation } from '@shared/collation'
import { collectPaths, joinPath, parentPath } from '@shared/docPaths'
import { shellText } from '@shared/bsonValue'
import type { CollectionInfo, DatabaseInfo, Doc, DocScope, FieldOp, FindRequest, FindResult, IndexInfo, ProfileQuery, ProfilingStatus, WriteResult } from '@shared/api'
import type { ConnectionConfig } from '@shared/connection'
import type { WriteOptions } from '@shared/changeHistoryApi'
import { captureBefore, docIdText, readByIds, recordUpdated } from '../changes/recorder'
import type { ConnRecorder } from '../changes/recorder'

/** Keep Int32 / Double / Long wrappers so edits can preserve the stored type. */
export const RAW_TYPES = { promoteValues: false, promoteLongs: false } as const

/** Validated `collation` driver option (undefined = none); an invalid document throws a readable error. */
export function collationOption(v: unknown): CollationOptions | undefined {
  return toCollation(v) as CollationOptions | undefined
}

const isUnauthorized = (e: unknown): boolean => {
  const err = e as { code?: number; codeName?: string }
  return err.code === 13 || err.codeName === 'Unauthorized'
}

/** Databases named by the user's roles and privileges (`connectionStatus` with showPrivileges). */
export function rolesDatabases(status: Document): string[] {
  const info = (status.authInfo ?? status) as Document
  const names = new Set<string>()
  for (const r of (info.authenticatedUserRoles ?? []) as { db?: unknown }[]) if (typeof r?.db === 'string') names.add(r.db)
  for (const p of (info.authenticatedUserPrivileges ?? []) as { resource?: { db?: unknown } }[]) if (typeof p?.resource?.db === 'string') names.add(p.resource.db)
  // '' stands for "any database"; $external only holds external users.
  names.delete('')
  names.delete('$external')
  return [...names]
}

/** Listed databases plus extra names (without size), sorted by name. */
export function mergeDatabases(listed: DatabaseInfo[], extra: Iterable<string>): DatabaseInfo[] {
  const out = new Map(listed.map((d) => [d.name, d]))
  for (const name of extra) if (name && !out.has(name)) out.set(name, { name })
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Databases for the tree. auto: listDatabases (retried with authorizedDatabases for users without the
 * privilege), plus databases the user's roles grant access to, plus the connection's extra names. manual: only
 * the connection's names.
 */
export async function listDatabases(client: MongoClient, cfg?: ConnectionConfig): Promise<DatabaseInfo[]> {
  const vis = cfg?.databases
  const manual = vis?.names ?? []
  if (vis?.mode === 'manual' && manual.length) return mergeDatabases([], manual)
  const admin = client.db('admin').admin()
  let listed: DatabaseInfo[] | null = null
  try {
    listed = (await admin.listDatabases()).databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk }))
  } catch (e) {
    if (!isUnauthorized(e)) throw e
    try {
      listed = (await admin.listDatabases({ nameOnly: true, authorizedDatabases: true })).databases.map((d) => ({ name: d.name }))
    } catch (e2) {
      if (!isUnauthorized(e2)) throw e2
    }
  }
  const extra = new Set(manual)
  try {
    for (const n of rolesDatabases(await client.db('admin').command({ connectionStatus: 1, showPrivileges: true }))) extra.add(n)
  } catch {
    // connectionStatus is allowed for every user; a failure only loses the role-derived names.
  }
  if (!listed?.length) {
    // Nothing listed: show the databases the connection settings name.
    if (cfg?.options.defaultDb) extra.add(cfg.options.defaultDb)
    if (cfg?.auth.authSource && cfg.auth.authSource !== '$external') extra.add(cfg.auth.authSource)
  }
  return mergeDatabases(listed ?? [], extra)
}

export async function listCollections(client: MongoClient, db: string): Promise<CollectionInfo[]> {
  const list = await client.db(db).listCollections({}, { authorizedCollections: true }).toArray()
  return list
    .map((c) => ({ name: c.name, type: (c.type ?? 'collection') as CollectionInfo['type'] }))
    .sort((a, b) => {
      const sa = a.name.startsWith('system.') ? 1 : 0
      const sb = b.name.startsWith('system.') ? 1 : 0
      return sa - sb || a.name.localeCompare(b.name)
    })
}

export async function estimatedCount(client: MongoClient, db: string, coll: string): Promise<number> {
  try {
    return await client.db(db).collection(coll).estimatedDocumentCount({ maxTimeMS: 5000 })
  } catch {
    return -1
  }
}

export async function find(client: MongoClient, db: string, coll: string, req: FindRequest, maxTimeMS = 0): Promise<FindResult> {
  const collation = collationOption(req.collation)
  const t0 = performance.now()
  const cursor = client
    .db(db)
    .collection(coll)
    .find(req.filter as Filter<Document>, {
      ...RAW_TYPES,
      projection: req.projection ?? undefined,
      sort: (req.sort ?? undefined) as Document | undefined,
      skip: req.skip || undefined,
      limit: req.limit || undefined,
      maxTimeMS: maxTimeMS || undefined,
      collation
    })
  const docs = (await cursor.toArray()) as Doc[]
  return { docs, ms: Math.round(performance.now() - t0) }
}

/** `collation` only matters with a filter: it decides which strings match. */
export async function count(client: MongoClient, db: string, coll: string, filter: Doc, maxTimeMS = 0, collation?: Doc | null): Promise<number> {
  return client
    .db(db)
    .collection(coll)
    .countDocuments(filter as Filter<Document>, { maxTimeMS: maxTimeMS || undefined, collation: collationOption(collation) })
}

export async function sampleFields(client: MongoClient, db: string, coll: string, size: number): Promise<string[]> {
  const docs = (await client
    .db(db)
    .collection(coll)
    .aggregate([{ $sample: { size } }], RAW_TYPES)
    .toArray()) as Doc[]
  return collectPaths(docs)
}

export async function getDocument(client: MongoClient, db: string, coll: string, id: unknown): Promise<Doc | null> {
  return (await client
    .db(db)
    .collection(coll)
    .findOne({ _id: id } as Filter<Document>, RAW_TYPES)) as Doc | null
}

const plural = (n: number, w: string): string => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`
const short = (v: unknown): string => {
  const s = shellText(v)
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

/** `rec` records the inserted ids in Change History so the insert can be undone. */
export async function insertDocuments(client: MongoClient, db: string, coll: string, docs: Doc[], rec?: ConnRecorder): Promise<number> {
  if (!docs.length) return 0
  const batch = rec?.begin(db, coll, 'edit', `Insert ${plural(docs.length, 'document')}`) ?? null
  const record = (ids: Record<number, unknown> | undefined): void => {
    if (batch && ids) batch.add(Object.entries(ids).map(([i, id]) => ({ op: 'insert', docId: id, after: { _id: id, ...docs[Number(i)] } })))
  }
  try {
    const r = await client.db(db).collection(coll).insertMany(docs as Document[], { ordered: true })
    record(r.insertedIds)
    return r.insertedCount
  } catch (e) {
    record((e as { insertedIds?: Record<number, unknown> }).insertedIds)
    throw e
  }
}

export async function replaceDocument(client: MongoClient, db: string, coll: string, id: unknown, doc: Doc, rec?: ConnRecorder): Promise<WriteResult> {
  const { _id, ...rest } = doc
  if (_id !== undefined && JSON.stringify(_id) !== JSON.stringify(id)) {
    throw new Error('_id field cannot be changed')
  }
  const c = client.db(db).collection(coll)
  const batch = rec?.begin(db, coll, 'edit', 'Replace document') ?? null
  const before = await captureBefore(c, { _id: id }, batch)
  const r = await c.replaceOne({ _id: id } as Filter<Document>, rest)
  if (r.matchedCount === 0) throw new Error('Document not found (it may have been deleted)')
  await recordUpdated(c, batch, before, 'replace')
  return { matched: r.matchedCount, modified: r.modifiedCount }
}

/** Collation of a filter scope (strings match as in the query tab that chose the documents). */
export const scopeCollation = (scope: DocScope): CollationOptions | undefined => (scope.kind === 'filter' ? collationOption(scope.collation) : undefined)

export function scopeFilter(scope: DocScope): Doc {
  switch (scope.kind) {
    case 'ids':
      return scope.ids.length === 1 ? { _id: scope.ids[0] } : { _id: { $in: scope.ids } }
    case 'filter':
      return scope.filter
    case 'all':
      return {}
  }
}

/** With `rec`, before images are captured first; more documents than the per-operation cap fail unless `opts.allowWithoutHistory`. */
export async function updateField(client: MongoClient, db: string, coll: string, scope: DocScope, op: FieldOp, opts?: WriteOptions, rec?: ConnRecorder): Promise<WriteResult> {
  if (op.path === '_id' || op.path.startsWith('_id.')) throw new Error('_id field cannot be changed')
  let update: Document
  switch (op.kind) {
    case 'set':
      update = { $set: { [op.path]: op.value } }
      break
    case 'unset':
      update = { $unset: { [op.path]: '' } }
      break
    case 'rename': {
      if (!op.newName || op.newName.includes('.')) throw new Error('Invalid field name')
      const target = joinPath(parentPath(op.path), op.newName)
      if (target === op.path) return { matched: 0, modified: 0 }
      update = { $rename: { [op.path]: target } }
      break
    }
  }
  const c = client.db(db).collection(coll)
  const filter = scopeFilter(scope)
  const collation = scopeCollation(scope)
  const single = scope.kind === 'ids' && scope.ids.length === 1
  const label = op.kind === 'rename' ? `$rename ${op.path} → ${op.newName}` : `$${op.kind} ${op.path}`
  const batch = rec?.begin(db, coll, single ? 'edit' : 'bulk', label) ?? null
  const before = await captureBefore(c, filter, batch, opts, collation)
  try {
    const r = await c.updateMany(filter as Filter<Document>, update, { collation })
    return { matched: r.matchedCount, modified: r.modifiedCount }
  } finally {
    await recordUpdated(c, batch, before).catch(() => {})
  }
}

/** Update Documents dialog: the user's own filter and update. See updateField for `opts` and `rec`. */
export async function updateDocuments(client: MongoClient, db: string, coll: string, req: UpdateRequest, opts?: WriteOptions, rec?: ConnRecorder): Promise<UpdateResult> {
  const problem = updateProblem(req.update, Array.isArray(req.update))
  if (problem) throw new Error(problem)
  const c = client.db(db).collection(coll)
  const collation = scopeCollation({ kind: 'filter', filter: req.filter, collation: req.collation })
  const update = req.update as Document | Document[]
  const label = `Update ${req.multi ? 'matching' : 'first match of'} ${short(req.filter)}`
  const batch = opts?.skipHistory ? null : (rec?.begin(db, coll, 'bulk', label) ?? null)
  // Without Multi only the first match changes: capture just that one (by _id, so the cap is not hit needlessly).
  let captureFilter: Doc = req.filter
  if (!req.multi && batch) {
    const first = await c.findOne(req.filter as Filter<Document>, { projection: { _id: 1 }, collation })
    if (first) captureFilter = { _id: first._id }
  }
  const before = await captureBefore(c, captureFilter, batch, opts, collation)
  try {
    const o = { upsert: req.upsert, collation }
    const r = req.multi ? await c.updateMany(req.filter as Filter<Document>, update, o) : await c.updateOne(captureFilter as Filter<Document>, update, o)
    return { matched: r.matchedCount, modified: r.modifiedCount, upserted: r.upsertedCount }
  } finally {
    await recordUpdated(c, batch, before).catch(() => {})
  }
}

/** See updateField for `opts` and `rec`. */
export async function deleteDocuments(client: MongoClient, db: string, coll: string, scope: DocScope, opts?: WriteOptions, rec?: ConnRecorder): Promise<number> {
  const c = client.db(db).collection(coll)
  const filter = scopeFilter(scope)
  const collation = scopeCollation(scope)
  const label = scope.kind === 'ids' ? `Delete ${plural(scope.ids.length, 'selected document')}` : scope.kind === 'all' ? 'Delete all documents' : `Delete matching ${short(filter)}`
  const batch = opts?.skipHistory ? null : (rec?.begin(db, coll, 'delete', label) ?? null)
  const before = await captureBefore(c, filter, batch, opts, collation)
  let ok = false
  try {
    const r = await c.deleteMany(filter as Filter<Document>, { collation })
    ok = true
    return r.deletedCount
  } finally {
    if (batch && before?.length) {
      // After a failure only the documents that are really gone are recorded.
      const left = ok ? new Map<string, Doc>() : await readByIds(c, before.map((d) => d._id)).catch(() => new Map<string, Doc>())
      batch.add(before.filter((d) => !left.has(docIdText(d._id))).map((d) => ({ op: 'delete' as const, before: d })))
    }
  }
}

export async function createCollection(client: MongoClient, db: string, coll: string): Promise<void> {
  await client.db(db).createCollection(coll)
}

export async function dropCollection(client: MongoClient, db: string, coll: string): Promise<void> {
  await client.db(db).collection(coll).drop()
}

export async function renameCollection(client: MongoClient, db: string, coll: string, newName: string): Promise<void> {
  await client.db(db).collection(coll).rename(newName)
}

export async function dropDatabase(client: MongoClient, db: string): Promise<void> {
  await client.db(db).dropDatabase()
}

// ---------------------------------------------------------------------------
// Profiling: explain, system.profile, currentOp
// ---------------------------------------------------------------------------

export async function explain(
  client: MongoClient,
  db: string,
  coll: string,
  req: FindRequest,
  verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution'
): Promise<Doc> {
  const cursor = client
    .db(db)
    .collection(coll)
    .find(req.filter as Filter<Document>, {
      projection: req.projection ?? undefined,
      sort: (req.sort ?? undefined) as Document | undefined,
      skip: req.skip || undefined,
      limit: req.limit || undefined,
      collation: collationOption(req.collation)
    })
  return (await cursor.explain(verbosity)) as Doc
}

export async function profilingStatus(client: MongoClient, db: string): Promise<ProfilingStatus> {
  const r = await client.db(db).command({ profile: -1 })
  return { level: Number(r.was ?? 0), slowms: Number(r.slowms ?? 100), sampleRate: Number(r.sampleRate ?? 1), filter: r.filter as Doc | undefined }
}

export async function setProfiling(client: MongoClient, db: string, level: number, slowms: number, sampleRate: number): Promise<ProfilingStatus> {
  if (![0, 1, 2].includes(level)) throw new Error('Profiling level must be 0, 1 or 2')
  await client.db(db).command({ profile: level, slowms, sampleRate })
  return profilingStatus(client, db)
}

export async function readProfile(client: MongoClient, db: string, q: ProfileQuery): Promise<Doc[]> {
  return (await client
    .db(db)
    .collection('system.profile')
    .find(q.filter as Filter<Document>)
    .sort({ ts: -1 })
    .limit(Math.min(Math.max(q.limit, 1), 10000))
    .toArray()) as Doc[]
}

/** system.profile is capped; it can only be emptied by dropping it while profiling is off. */
export async function clearProfile(client: MongoClient, db: string): Promise<void> {
  const status = await profilingStatus(client, db)
  if (status.level !== 0) await client.db(db).command({ profile: 0 })
  try {
    await client.db(db).collection('system.profile').drop()
  } catch (e) {
    if ((e as { codeName?: string }).codeName !== 'NamespaceNotFound') throw e
  } finally {
    if (status.level !== 0) await client.db(db).command({ profile: status.level, slowms: status.slowms, sampleRate: status.sampleRate })
  }
}

export async function currentOps(client: MongoClient, opts: { allUsers: boolean; idle: boolean }): Promise<Doc[]> {
  const docs = await client
    .db('admin')
    .aggregate([{ $currentOp: { allUsers: opts.allUsers, idleConnections: opts.idle, idleSessions: opts.idle } }, { $sort: { secs_running: -1 } }])
    .toArray()
  return docs as Doc[]
}

export async function killOp(client: MongoClient, opid: unknown): Promise<void> {
  await client.db('admin').command({ killOp: 1, op: opid })
}

export async function listIndexes(client: MongoClient, db: string, coll: string): Promise<IndexInfo[]> {
  try {
    return (await client.db(db).collection(coll).listIndexes().toArray()) as unknown as IndexInfo[]
  } catch (e) {
    if ((e as { codeName?: string }).codeName === 'NamespaceNotFound') return []
    throw e
  }
}

export async function createIndex(
  client: MongoClient,
  db: string,
  coll: string,
  keys: Doc,
  options: Doc
): Promise<string> {
  // Drops unset flags; keeps 0 (expireAfterSeconds: 0 is valid).
  const o = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false))
  return client.db(db).collection(coll).createIndex(keys as Document, o)
}
