import type { Doc } from './api'

/**
 * Server Status dashboard, collection validation rules and view editing. Implemented by `serverHandlers()` in
 * src/main/server/handlers.ts.
 */

/** One dashboard section: a permission error (e.g. missing clusterMonitor) does not fail the whole page. */
export type Section<T> = { ok: true; value: T } | { ok: false; error: string; denied: boolean }

export const OP_TYPES = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const
export type OpType = (typeof OP_TYPES)[number]
export type OpCounters = Record<OpType, number>

/** Small subset of `serverStatus`, sampled by the dashboard every few seconds. */
export interface ServerSample {
  /** Client clock (ms) when the sample was taken. */
  at: number
  /** Seconds since the server process started. */
  uptime: number
  host: string
  version: string
  process: string
  connections: { current: number; available: number; totalCreated: number }
  opcounters: OpCounters
  opcountersRepl?: OpCounters
  network: { bytesIn: number; bytesOut: number; numRequests: number }
  /** Megabytes. */
  mem: { resident: number; virtual: number }
  /** WiredTiger cache, bytes. */
  cache?: { bytes: number; max: number; dirty: number; readInto: number; writtenFrom: number }
  globalLock?: { activeClients: number; activeReaders: number; activeWriters: number; currentQueue: number; queueReaders: number; queueWriters: number }
  asserts?: { regular: number; warning: number; msg: number; user: number; rollovers: number }
  transactions?: { currentActive: number; currentOpen: number; totalStarted: number; totalCommitted: number; totalAborted: number }
  document?: { inserted: number; updated: number; deleted: number; returned: number }
  scanAndOrder?: number
  queryExecutor?: { scanned: number; scannedObjects: number }
}

export type Topology = 'standalone' | 'replicaSet' | 'sharded'

export interface HostInfo {
  hostname: string
  os: string
  cpuArch: string
  cpuCores: number
  memSizeMB: number
}

export interface ServerInfo {
  host: string
  version: string
  topology: Topology
  setName?: string
  primary?: string
  /** This node is the writable primary (replica sets). */
  isPrimary?: boolean
  storageEngine?: string
  hostInfo: Section<HostInfo>
}

export interface ReplMember {
  name: string
  state: number
  stateStr: string
  health: number
  /** Seconds. */
  uptime: number
  optimeDate?: Date
  /** Seconds behind the primary (or the most recent member when there is no primary). */
  lagSec?: number
  pingMs?: number
  syncSourceHost?: string
  self?: boolean
}

export interface ReplSetStatus {
  set: string
  date: Date
  members: ReplMember[]
  primary?: string
}

export interface OplogInfo {
  first?: Date
  last?: Date
  /** last − first, seconds. */
  windowSec?: number
  sizeBytes: number
  maxBytes: number
  count: number
}

export interface ReplicationInfo {
  status: Section<ReplSetStatus>
  oplog: Section<OplogInfo>
}

export interface ShardInfo {
  id: string
  host: string
  state?: number
  draining?: boolean
  tags?: string[]
}

export interface BalancerInfo {
  mode: string
  inBalancerRound: boolean
  numBalancerRounds: number
}

export interface ShardingInfo {
  shards: Section<ShardInfo[]>
  balancer: Section<BalancerInfo>
}

export interface DbStatsRow {
  name: string
  dataSize: number
  storageSize: number
  indexSize: number
  objects: number
  collections: number
  views: number
  error?: string
}

// ---------------------------------------------------------------------------
// Validation rules
// ---------------------------------------------------------------------------

export const VALIDATION_LEVELS = ['off', 'strict', 'moderate'] as const
export type ValidationLevel = (typeof VALIDATION_LEVELS)[number]
export const VALIDATION_ACTIONS = ['error', 'warn', 'errorAndLog'] as const
export type ValidationAction = (typeof VALIDATION_ACTIONS)[number]

export interface ValidationRules {
  /** null = no validator. */
  validator: Doc | null
  level: ValidationLevel
  action: ValidationAction
}

export interface ValidationState extends ValidationRules {
  serverVersion: string
  /** Actions this server accepts (`errorAndLog` needs MongoDB 8.1+). */
  actions: ValidationAction[]
}

export interface ValidationTestResult {
  /** Documents checked. */
  sampled: number
  failed: number
  passed: number
  /** Estimated collection size. */
  total: number
  /** Up to 20 failing documents. */
  failures: Doc[]
  ms: number
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ViewDefinition {
  name: string
  viewOn: string
  pipeline: Doc[]
}

/** Renderer-callable methods. */
export interface ServerApi {
  serverInfo(connId: string): ServerInfo
  serverSample(connId: string): Section<ServerSample>
  /** null when the server is not a replica set member. */
  serverReplication(connId: string): ReplicationInfo | null
  /** null when not connected to a mongos. */
  serverSharding(connId: string): ShardingInfo | null
  serverDbStats(connId: string): Section<DbStatsRow[]>

  validationGet(connId: string, db: string, coll: string): ValidationState
  validationSet(connId: string, db: string, coll: string, rules: ValidationRules): ValidationState
  /** Checks `sample` documents (0 = all) against `validator`. */
  validationTest(connId: string, db: string, coll: string, validator: Doc, sample: number): ValidationTestResult

  viewGet(connId: string, db: string, name: string): ViewDefinition
  /** collMod the view's source and pipeline. Rejects $out / $merge. */
  viewUpdate(connId: string, db: string, name: string, viewOn: string, pipeline: Doc[]): void
}
