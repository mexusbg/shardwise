import type { Admin, Collection, Db, Document, MongoClient } from 'mongodb'
import type { ConnectionConfig } from '@shared/connection'
import type { ImportRequest } from '@shared/api'
import type { FromSqlRequest } from '@shared/migrationApi'
import type { MaskRequest, ReschemaRequest } from '@shared/maskingApi'

/**
 * Read-only connections. The client handed out for a read-only connection is wrapped so every write method of
 * the driver (collection, database, admin and client level) is refused before anything reaches the server. All
 * main-process features (editing, jobs, MCP, AI tools, Change History restores) get their client from the
 * ConnectionManager, so they are covered without checks of their own; job starters still check up front to fail
 * fast, and external tools (mongorestore) are refused by those checks.
 */

export class ReadOnlyError extends Error {
  readonly code = 'READ_ONLY'
  constructor(connName: string, action?: string) {
    super(readOnlyMessage(connName, action))
    this.name = 'ReadOnlyError'
  }
}

export function readOnlyMessage(connName: string, action?: string): string {
  return `"${connName}" is a read-only connection${action ? `: ${action} is not allowed` : ''}. Turn off "Read-only" in the connection settings to make changes.`
}

export const isReadOnlyError = (e: unknown): boolean => (e as { code?: string })?.code === 'READ_ONLY' || /is a read-only connection/.test(String((e as Error)?.message ?? ''))

/** Jobs that write into a MongoDB connection (checked before they start; mongorestore bypasses the guarded client). */
export type WriteJob =
  | { kind: 'import'; request: ImportRequest }
  | { kind: 'sqlImport'; request: FromSqlRequest }
  | { kind: 'mask'; request: MaskRequest }
  | { kind: 'reschema'; request: ReschemaRequest }

/** The connection a job writes into, or null when it writes nowhere in MongoDB (masking to a file). */
export function jobWriteTarget(j: WriteJob): { connId: string; action: string } | null {
  switch (j.kind) {
    case 'import':
      return { connId: j.request.connId, action: `importing into ${j.request.db}` }
    case 'sqlImport':
      return { connId: j.request.connId, action: `importing from SQL into ${j.request.db}` }
    case 'reschema':
      return { connId: j.request.connId, action: `restructuring ${j.request.db}.${j.request.coll}` }
    case 'mask': {
      const t = j.request.target
      if (t.kind === 'collection') return { connId: t.connId, action: `writing masked documents to ${t.db}.${t.coll}` }
      if (t.kind === 'inPlace') return { connId: j.request.source.connId, action: 'masking documents in place' }
      return null
    }
  }
}

/** Throws ReadOnlyError when the job would write into a read-only connection. */
export function assertJobWritable(j: WriteJob, config: (connId: string) => Pick<ConnectionConfig, 'name' | 'readOnly'>): void {
  const t = jobWriteTarget(j)
  if (!t) return
  const cfg = config(t.connId)
  if (cfg.readOnly) throw new ReadOnlyError(cfg.name, t.action)
}

/** Collection methods that change data, indexes or the collection itself. */
const COLLECTION_WRITES = new Set([
  'insertOne',
  'insertMany',
  'bulkWrite',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'rename',
  'drop',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'initializeOrderedBulkOp',
  'initializeUnorderedBulkOp',
  'createSearchIndex',
  'createSearchIndexes',
  'dropSearchIndex',
  'updateSearchIndex'
])

const DB_WRITES = new Set(['createCollection', 'dropCollection', 'dropDatabase', 'renameCollection', 'createIndex', 'removeUser', 'setProfilingLevel'])

/** Server commands that write (data, schema, users, server state). Compared case-insensitively. */
const WRITE_COMMANDS = new Set(
  [
    'insert',
    'update',
    'delete',
    'findAndModify',
    'create',
    'createIndexes',
    'drop',
    'dropDatabase',
    'dropIndexes',
    'deleteIndexes',
    'collMod',
    'renameCollection',
    'convertToCapped',
    'cloneCollectionAsCapped',
    'compact',
    'reIndex',
    'createSearchIndexes',
    'dropSearchIndex',
    'updateSearchIndex',
    'createUser',
    'updateUser',
    'dropUser',
    'dropAllUsersFromDatabase',
    'grantRolesToUser',
    'revokeRolesFromUser',
    'createRole',
    'updateRole',
    'dropRole',
    'dropAllRolesFromDatabase',
    'grantRolesToRole',
    'revokeRolesFromRole',
    'grantPrivilegesToRole',
    'revokePrivilegesFromRole',
    'killOp',
    'killSessions',
    'killAllSessions',
    'killAllSessionsByPattern',
    'applyOps',
    'mapReduce',
    'shardCollection',
    'reshardCollection',
    'enableSharding',
    'moveChunk',
    'movePrimary',
    'splitChunk',
    'setFeatureCompatibilityVersion',
    'setParameter',
    'shutdown',
    'fsync',
    'replSetReconfig',
    'replSetStepDown',
    'commitTransaction'
  ].map((c) => c.toLowerCase())
)

const WRITE_STAGES = ['$out', '$merge']

/** First write stage ($out / $merge) of a pipeline, if any. */
export function writeStage(pipeline: unknown): string | undefined {
  if (!Array.isArray(pipeline)) return undefined
  for (const s of pipeline) {
    if (s && typeof s === 'object') {
      const k = Object.keys(s as Document).find((x) => WRITE_STAGES.includes(x))
      if (k) return k
    }
  }
  return undefined
}

/** Why a command document writes, or undefined when it only reads. */
export function writeCommand(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return WRITE_COMMANDS.has(cmd.toLowerCase()) ? cmd : undefined
  if (!cmd || typeof cmd !== 'object') return undefined
  const name = Object.keys(cmd as Document)[0]
  if (!name) return undefined
  const lower = name.toLowerCase()
  // { profile: -1 } only reads the profiling level.
  if (lower === 'profile') return Number((cmd as Document)[name]) === -1 ? undefined : 'profile'
  if (lower === 'aggregate') {
    const stage = writeStage((cmd as Document).pipeline)
    return stage ? `aggregate with ${stage}` : undefined
  }
  return WRITE_COMMANDS.has(lower) ? name : undefined
}

type Check = (action: string) => void
type Fn = (...a: unknown[]) => unknown

/** Driver methods that return synchronously (builders and cursors); the others return promises. */
const SYNC = new Set(['initializeOrderedBulkOp', 'initializeUnorderedBulkOp', 'aggregate', 'runCursorCommand', 'collection', 'admin'])

/** Function values are bound to the target so private fields keep working; `wrap` replaces chosen methods. */
function proxy<T extends object>(target: T, wrap: (prop: string, fn: Fn) => Fn | undefined): T {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown
      if (typeof v !== 'function') return v
      const fn = (v as Fn).bind(t)
      return (typeof prop === 'string' && wrap(prop, fn)) || fn
    }
  })
}

/** Runs `fn` after `check` passes; refusals of async methods come back as rejected promises like driver errors. */
function guarded(prop: string, fn: Fn, check: (args: unknown[]) => void): Fn {
  if (SYNC.has(prop))
    return (...a) => {
      check(a)
      return fn(...a)
    }
  return (...a) => {
    try {
      check(a)
    } catch (e) {
      return Promise.reject(e)
    }
    return fn(...a)
  }
}

const commandCheck =
  (check: Check) =>
  (a: unknown[]): void => {
    const w = writeCommand(a[0])
    if (w) check(`the ${w} command`)
  }

const pipelineCheck =
  (check: Check) =>
  (a: unknown[]): void => {
    const s = writeStage(a[0])
    if (s) check(`a pipeline with ${s}`)
  }

function guardAdmin(admin: Admin, check: Check): Admin {
  return proxy(admin, (prop, fn) => {
    if (prop === 'removeUser') return guarded(prop, fn, () => check('removeUser'))
    if (prop === 'command') return guarded(prop, fn, commandCheck(check))
    return undefined
  })
}

function guardCollection<T extends Document>(coll: Collection<T>, check: Check): Collection<T> {
  return proxy(coll, (prop, fn) => {
    if (COLLECTION_WRITES.has(prop)) return guarded(prop, fn, () => check(`${prop} on ${coll.dbName}.${coll.collectionName}`))
    if (prop === 'aggregate') return guarded(prop, fn, pipelineCheck(check))
    return undefined
  })
}

function guardDb(db: Db, check: Check): Db {
  return proxy(db, (prop, fn) => {
    if (DB_WRITES.has(prop)) return guarded(prop, fn, () => check(`${prop} on ${db.databaseName}`))
    if (prop === 'collection') return (...a) => guardCollection(fn(...a) as Collection, check)
    if (prop === 'collections') return async (...a) => ((await fn(...a)) as Collection[]).map((c) => guardCollection(c, check))
    if (prop === 'admin') return () => guardAdmin(fn() as Admin, check)
    if (prop === 'command' || prop === 'runCursorCommand') return guarded(prop, fn, commandCheck(check))
    if (prop === 'aggregate') return guarded(prop, fn, pipelineCheck(check))
    return undefined
  })
}

/**
 * A client whose write methods fail with ReadOnlyError while `isReadOnly()` is true. The flag is read on every
 * call, so switching a connection to read-only (or back) while it is open applies to clients already handed out.
 */
export function readOnlyClient(client: MongoClient, connName: () => string, isReadOnly: () => boolean = () => true): MongoClient {
  const check: Check = (action) => {
    if (isReadOnly()) throw new ReadOnlyError(connName(), action)
  }
  return proxy(client, (prop, fn) => {
    if (prop === 'db') return (...a) => guardDb(fn(...a) as Db, check)
    if (prop === 'bulkWrite') return guarded(prop, fn, () => check('a client bulkWrite'))
    return undefined
  })
}

