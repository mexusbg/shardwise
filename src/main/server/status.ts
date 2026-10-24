import type { Document, MongoClient } from 'mongodb'
import { OP_TYPES } from '@shared/serverApi'
import type {
  BalancerInfo,
  DbStatsRow,
  HostInfo,
  OpCounters,
  OplogInfo,
  ReplMember,
  ReplSetStatus,
  ReplicationInfo,
  Section,
  ServerInfo,
  ServerSample,
  ShardInfo,
  ShardingInfo,
  Topology
} from '@shared/serverApi'
import { withLag } from '@shared/serverStats'

type D = Record<string, unknown>

/** Number from a BSON numeric (Int32, Long, Double, Decimal128) or JS number. */
export function num(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  const o = v as { toNumber?: () => number; valueOf?: () => unknown; toString?: () => string }
  if (typeof o.toNumber === 'function') return o.toNumber()
  const p = typeof o.valueOf === 'function' ? o.valueOf() : v
  if (typeof p === 'number') return p
  const n = Number(String(v))
  return Number.isFinite(n) ? n : 0
}

const obj = (v: unknown): D | undefined => (v && typeof v === 'object' ? (v as D) : undefined)

export function isDenied(e: unknown): boolean {
  const err = e as { code?: number; codeName?: string; message?: string }
  return err?.code === 13 || err?.codeName === 'Unauthorized' || /not authori[sz]ed/i.test(err?.message ?? '')
}

export async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e), denied: isDenied(e) }
  }
}

function opCounters(v: unknown): OpCounters | undefined {
  const o = obj(v)
  if (!o) return undefined
  const out = {} as OpCounters
  for (const k of OP_TYPES) out[k] = num(o[k])
  return out
}

/** The dashboard's subset of a `serverStatus` reply. */
export function pickSample(s: D, at = Date.now()): ServerSample {
  const conn = obj(s.connections) ?? {}
  const net = obj(s.network) ?? {}
  const mem = obj(s.mem) ?? {}
  const cache = obj(obj(s.wiredTiger)?.cache)
  const gl = obj(s.globalLock)
  const asserts = obj(s.asserts)
  const tx = obj(s.transactions)
  const metrics = obj(s.metrics)
  const doc = obj(metrics?.document)
  const qe = obj(metrics?.queryExecutor)
  const sample: ServerSample = {
    at,
    uptime: num(s.uptime),
    host: String(s.host ?? ''),
    version: String(s.version ?? ''),
    process: String(s.process ?? ''),
    connections: { current: num(conn.current), available: num(conn.available), totalCreated: num(conn.totalCreated) },
    opcounters: opCounters(s.opcounters) ?? { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    network: { bytesIn: num(net.bytesIn), bytesOut: num(net.bytesOut), numRequests: num(net.numRequests) },
    mem: { resident: num(mem.resident), virtual: num(mem.virtual) }
  }
  const repl = opCounters(s.opcountersRepl)
  if (repl) sample.opcountersRepl = repl
  if (cache)
    sample.cache = {
      bytes: num(cache['bytes currently in the cache']),
      max: num(cache['maximum bytes configured']),
      dirty: num(cache['tracked dirty bytes in the cache']),
      readInto: num(cache['bytes read into cache']),
      writtenFrom: num(cache['bytes written from cache'])
    }
  if (gl) {
    const ac = obj(gl.activeClients) ?? {}
    const q = obj(gl.currentQueue) ?? {}
    sample.globalLock = {
      activeClients: num(ac.total),
      activeReaders: num(ac.readers),
      activeWriters: num(ac.writers),
      currentQueue: num(q.total),
      queueReaders: num(q.readers),
      queueWriters: num(q.writers)
    }
  }
  if (asserts)
    sample.asserts = {
      regular: num(asserts.regular),
      warning: num(asserts.warning),
      msg: num(asserts.msg),
      user: num(asserts.user),
      rollovers: num(asserts.rollovers)
    }
  if (tx)
    sample.transactions = {
      currentActive: num(tx.currentActive),
      currentOpen: num(tx.currentOpen),
      totalStarted: num(tx.totalStarted),
      totalCommitted: num(tx.totalCommitted),
      totalAborted: num(tx.totalAborted)
    }
  if (doc) sample.document = { inserted: num(doc.inserted), updated: num(doc.updated), deleted: num(doc.deleted), returned: num(doc.returned) }
  const op = obj(metrics?.operation)
  if (op && op.scanAndOrder != null) sample.scanAndOrder = num(op.scanAndOrder)
  if (qe) sample.queryExecutor = { scanned: num(qe.scanned), scannedObjects: num(qe.scannedObjects) }
  return sample
}

export async function serverSample(client: MongoClient): Promise<Section<ServerSample>> {
  return section(async () => {
    const s = await client.db('admin').command({ serverStatus: 1, locks: 0, repl: 0, tcmalloc: 0, mirroredReads: 0, flowControl: 0 })
    return pickSample(s as D)
  })
}

async function hello(client: MongoClient): Promise<D> {
  return (await client.db('admin').command({ hello: 1 })) as D
}

export function topologyOf(h: D): Topology {
  if (h.msg === 'isdbgrid') return 'sharded'
  if (h.setName) return 'replicaSet'
  return 'standalone'
}

export async function serverInfo(client: MongoClient): Promise<ServerInfo> {
  const h = await hello(client)
  const build = (await client.db('admin').command({ buildInfo: 1 })) as D
  const hostInfo = await section(async (): Promise<HostInfo> => {
    const r = (await client.db('admin').command({ hostInfo: 1 })) as D
    const sys = obj(r.system) ?? {}
    const os = obj(r.os) ?? {}
    return {
      hostname: String(sys.hostname ?? ''),
      os: [os.name, os.version].filter(Boolean).join(' ') || String(os.type ?? ''),
      cpuArch: String(sys.cpuArch ?? ''),
      cpuCores: num(sys.numCores),
      memSizeMB: num(sys.memSizeMB)
    }
  })
  const topology = topologyOf(h)
  const info: ServerInfo = {
    host: String(h.me ?? (hostInfo.ok ? hostInfo.value.hostname : '')),
    version: String(build.version ?? ''),
    topology,
    hostInfo
  }
  if (topology === 'replicaSet') {
    info.setName = String(h.setName)
    if (h.primary) info.primary = String(h.primary)
    info.isPrimary = !!(h.isWritablePrimary ?? h.ismaster)
  }
  const engine = await section(async () => obj(((await client.db('admin').command({ serverStatus: 1, ...SKIP_ALL })) as D).storageEngine)?.name)
  if (engine.ok && engine.value) info.storageEngine = String(engine.value)
  return info
}

/** serverStatus sections to leave out when only `storageEngine` is wanted. */
const SKIP_ALL = { locks: 0, repl: 0, metrics: 0, wiredTiger: 0, opcounters: 0, opcountersRepl: 0, network: 0, asserts: 0, connections: 0, transactions: 0, tcmalloc: 0, mirroredReads: 0, flowControl: 0 }

function member(m: D): ReplMember {
  const out: ReplMember = {
    name: String(m.name ?? ''),
    state: num(m.state),
    stateStr: String(m.stateStr ?? ''),
    health: num(m.health),
    uptime: num(m.uptime)
  }
  if (m.optimeDate instanceof Date) out.optimeDate = m.optimeDate
  if (m.pingMs != null) out.pingMs = num(m.pingMs)
  if (m.syncSourceHost) out.syncSourceHost = String(m.syncSourceHost)
  if (m.self) out.self = true
  return out
}

const tsSeconds = (ts: unknown): number | undefined => {
  const t = ts as { high?: number; getHighBits?: () => number; t?: number } | undefined
  if (!t) return undefined
  if (typeof t.getHighBits === 'function') return t.getHighBits() >>> 0
  if (typeof t.t === 'number') return t.t
  return typeof t.high === 'number' ? t.high >>> 0 : undefined
}

export async function oplogInfo(client: MongoClient): Promise<OplogInfo> {
  const local = client.db('local')
  const oplog = local.collection('oplog.rs')
  const [first] = await oplog.find({}, { sort: { $natural: 1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray()
  const [last] = await oplog.find({}, { sort: { $natural: -1 }, limit: 1, projection: { ts: 1, wall: 1 } }).toArray()
  let stats: D = {}
  try {
    const [s] = await oplog.aggregate([{ $collStats: { storageStats: {} } }]).toArray()
    stats = obj((s as D | undefined)?.storageStats) ?? {}
  } catch {
    stats = (await local.command({ collStats: 'oplog.rs' })) as D
  }
  const f = tsSeconds(first?.ts)
  const l = tsSeconds(last?.ts)
  const out: OplogInfo = { sizeBytes: num(stats.size), maxBytes: num(stats.maxSize), count: num(stats.count) }
  if (f != null) out.first = new Date(f * 1000)
  if (l != null) out.last = new Date(l * 1000)
  if (f != null && l != null) out.windowSec = Math.max(0, l - f)
  return out
}

export async function replication(client: MongoClient): Promise<ReplicationInfo | null> {
  const h = await hello(client)
  if (topologyOf(h) !== 'replicaSet') return null
  const status = await section(async (): Promise<ReplSetStatus> => {
    const r = (await client.db('admin').command({ replSetGetStatus: 1 })) as D
    const members = withLag(((r.members as D[] | undefined) ?? []).map(member))
    const primary = members.find((m) => m.stateStr === 'PRIMARY')?.name
    return { set: String(r.set ?? h.setName ?? ''), date: r.date instanceof Date ? r.date : new Date(), members, ...(primary ? { primary } : {}) }
  })
  if (!status.ok && /NotYetInitialized|no replset config|not running with --replSet/i.test(status.error)) return null
  const oplog = await section(() => oplogInfo(client))
  return { status, oplog }
}

export async function sharding(client: MongoClient): Promise<ShardingInfo | null> {
  const h = await hello(client)
  if (topologyOf(h) !== 'sharded') return null
  const admin = client.db('admin')
  const shards = await section(async (): Promise<ShardInfo[]> => {
    const r = (await admin.command({ listShards: 1 })) as D
    return ((r.shards as D[] | undefined) ?? []).map((s) => ({
      id: String(s._id),
      host: String(s.host ?? ''),
      ...(s.state != null ? { state: num(s.state) } : {}),
      ...(s.draining ? { draining: true } : {}),
      ...(Array.isArray(s.tags) && s.tags.length ? { tags: s.tags.map(String) } : {})
    }))
  })
  const balancer = await section(async (): Promise<BalancerInfo> => {
    const r = (await admin.command({ balancerStatus: 1 })) as D
    return { mode: String(r.mode ?? ''), inBalancerRound: !!r.inBalancerRound, numBalancerRounds: num(r.numBalancerRounds) }
  })
  return { shards, balancer }
}

export async function dbStats(client: MongoClient): Promise<Section<DbStatsRow[]>> {
  return section(async () => {
    const r = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true } as Document)
    const names = (r.databases as { name: string }[]).map((d) => d.name)
    const rows = await Promise.all(
      names.map(async (name): Promise<DbStatsRow> => {
        try {
          const s = (await client.db(name).command({ dbStats: 1, scale: 1 })) as D
          return {
            name,
            dataSize: num(s.dataSize),
            storageSize: num(s.storageSize),
            indexSize: num(s.indexSize),
            objects: num(s.objects),
            collections: num(s.collections),
            views: num(s.views)
          }
        } catch (e) {
          return { name, dataSize: 0, storageSize: 0, indexSize: 0, objects: 0, collections: 0, views: 0, error: (e as Error).message }
        }
      })
    )
    return rows.sort((a, b) => b.storageSize + b.indexSize - (a.storageSize + a.indexSize) || a.name.localeCompare(b.name))
  })
}
