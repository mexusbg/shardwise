import type { Doc } from './api'

export interface PlanStats {
  nReturned?: number
  /** executionTimeMillisEstimate (or executionTimeMillis for shard / merge stages). */
  timeMs?: number
  works?: number
  advanced?: number
  needTime?: number
  needYield?: number
  docsExamined?: number
  keysExamined?: number
  isEOF?: boolean
  usedDisk?: boolean
  memUsage?: number
  raw: Doc
}

export interface PlanNode {
  /** Path in the tree ('0', '0.1', …). */
  id: string
  stage: string
  /** Extra caption, e.g. the shard name. */
  label?: string
  details: Doc
  stats?: PlanStats
  children: PlanNode[]
}

export type ExplainWarningKind = 'collscan' | 'sort' | 'ratio' | 'failed'
export interface ExplainWarning {
  kind: ExplainWarningKind
  text: string
}

export interface ExplainSummary {
  hasStats: boolean
  engine: 'classic' | 'sbe'
  sharded: boolean
  shardCount: number
  namespace?: string
  explainVersion?: string
  nReturned?: number
  docsExamined?: number
  keysExamined?: number
  timeMs?: number
  /** Documents examined per document returned. */
  ratio?: number
  indexes: string[]
  collscan: boolean
  inMemorySort: boolean
  sortUsedDisk: boolean
  /** An index answered the query without fetching documents. */
  covered: boolean
  filtered: boolean
  isCached?: boolean
  queryHash?: string
  planCacheKey?: string
  indexFilterSet?: boolean
  rejectedPlans: number
  executionSuccess?: boolean
  errorMessage?: string
  warnings: ExplainWarning[]
}

export interface ParsedExplain {
  summary: ExplainSummary
  root: PlanNode
  rejected: PlanNode[]
}

const CHILD_KEYS = ['inputStage', 'inputStages', 'outerStage', 'innerStage', 'thenStage', 'elseStage']
const STAT_KEYS = new Set([
  'nReturned', 'executionTimeMillisEstimate', 'executionTimeMillis', 'executionTimeMicros', 'executionTimeNanos', 'works', 'advanced',
  'needTime', 'needYield', 'saveState', 'restoreState', 'isEOF', 'docsExamined', 'keysExamined', 'seeks', 'dupsTested', 'dupsDropped',
  'alreadyHasObj', 'memUsage', 'memLimit', 'totalDataSizeSorted', 'usedDisk', 'spills', 'spilledDataStorageSize', 'spilledRecords',
  'spilledBytes', 'peakTrackedMemBytes', 'invalidates', 'opens', 'closes', 'numReads', 'nSkipped', 'nCounted', 'chunkSkips',
  'totalChildMillis', 'totalKeysExamined', 'totalDocsExamined', 'executionSuccess', 'numTested', 'failed', 'nMatched', 'nWouldModify'
])
const SBE_KEY_STAGE = /^(ix|simple_index|count_scan)/
const SBE_DOC_STAGE = /^(scan|seek|parallel_scan)$/

export const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Plain number from a JS number or a BSON numeric wrapper. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v && typeof v === 'object' && '_bsontype' in v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

export function childStages(s: Doc): Doc[] {
  const out: Doc[] = []
  for (const k of CHILD_KEYS) {
    const v = s[k]
    if (isDoc(v)) out.push(v)
    else if (Array.isArray(v)) out.push(...v.filter(isDoc))
  }
  return out
}

function omit(s: Doc, keys: string[]): Doc {
  const out: Doc = {}
  for (const [k, v] of Object.entries(s)) if (!keys.includes(k)) out[k] = v
  return out
}

function pickStats(s: Doc): Doc {
  const out: Doc = {}
  for (const [k, v] of Object.entries(s)) if (STAT_KEYS.has(k)) out[k] = v
  return out
}

function statsOf(raw: Doc): PlanStats {
  return {
    nReturned: num(raw.nReturned),
    timeMs: num(raw.executionTimeMillisEstimate) ?? num(raw.executionTimeMillis),
    works: num(raw.works),
    advanced: num(raw.advanced),
    needTime: num(raw.needTime),
    needYield: num(raw.needYield),
    docsExamined: num(raw.docsExamined) ?? num(raw.totalDocsExamined),
    keysExamined: num(raw.keysExamined) ?? num(raw.totalKeysExamined),
    isEOF: bool(raw.isEOF) ?? (raw.isEOF === 1 ? true : raw.isEOF === 0 ? false : undefined),
    usedDisk: bool(raw.usedDisk),
    memUsage: num(raw.memUsage) ?? num(raw.totalDataSizeSorted),
    raw
  }
}

function node(stage: string, details: Doc, children: PlanNode[] = [], stats?: PlanStats, label?: string): PlanNode {
  return { id: '', stage, label, details, stats, children }
}

/** Plan tree from a stage document (classic winningPlan / executionStages, or an SBE tree as is). */
function buildNode(s: Doc, withStats: boolean): PlanNode {
  const details: Doc = {}
  const raw: Doc = {}
  for (const [k, v] of Object.entries(s)) {
    if (CHILD_KEYS.includes(k)) continue
    if (withStats && STAT_KEYS.has(k)) raw[k] = v
    else details[k] = v
  }
  const stats = withStats && Object.keys(raw).length ? statsOf(raw) : undefined
  return node(String(s.stage ?? '?'), details, childStages(s).map((c) => buildNode(c, withStats)), stats)
}

const isSbeStage = (s: Doc): boolean => typeof s.stage === 'string' && /[a-z]/.test(s.stage) && s.stage === s.stage.toLowerCase() && !s.stage.startsWith('$')

function walk(n: PlanNode, fn: (n: PlanNode) => void): void {
  fn(n)
  n.children.forEach((c) => walk(c, fn))
}

/** SBE execution stages grouped by the logical plan node they implement (pre-order, so [0] is the topmost). */
function sbeByPlanNode(exec: Doc): Map<number, Doc[]> {
  const m = new Map<number, Doc[]>()
  const visit = (s: Doc): void => {
    const id = num(s.planNodeId)
    if (id !== undefined) {
      if (!m.has(id)) m.set(id, [])
      m.get(id)!.push(s)
    }
    childStages(s).forEach(visit)
  }
  visit(exec)
  return m
}

function sbeStats(stages: Doc[]): PlanStats {
  const top = stages[0]
  let docs: number | undefined
  let keys: number | undefined
  for (const s of stages) {
    const name = String(s.stage ?? '')
    const k = num(s.keysExamined) ?? (SBE_KEY_STAGE.test(name) ? num(s.numReads) : undefined)
    const d = num(s.docsExamined) ?? (SBE_DOC_STAGE.test(name) ? num(s.numReads) : undefined)
    if (k !== undefined) keys = (keys ?? 0) + k
    if (d !== undefined) docs = (docs ?? 0) + d
  }
  // totalDocsExamined / totalKeysExamined on SBE stages are subtree totals, not this node's own work.
  const st = statsOf({ ...omit(top, [...CHILD_KEYS, 'stage', 'planNodeId']), sbeStages: stages.map((s) => s.stage) })
  st.docsExamined = docs
  st.keysExamined = keys
  return st
}

function attachPositional(n: PlanNode, exec: Doc | undefined): void {
  if (!exec) return
  if (String(exec.stage ?? '').toUpperCase() === n.stage.toUpperCase()) n.stats = statsOf(pickStats(exec))
  const ec = childStages(exec)
  n.children.forEach((c, i) => attachPositional(c, ec[i]))
}

interface Ctx {
  sbe: boolean
  rejected: PlanNode[]
}

function rejectedTree(rp: Doc): PlanNode {
  return buildNode(isDoc(rp.queryPlan) ? rp.queryPlan : rp, false)
}

function planTree(wp: Doc | undefined, exec: Doc | undefined, ctx: Ctx): PlanNode {
  if (wp && Array.isArray(wp.shards)) return shardTree(wp, exec, ctx)
  if (wp && (isDoc(wp.queryPlan) || isDoc(wp.slotBasedPlan))) ctx.sbe = true
  if (exec && isSbeStage(exec)) ctx.sbe = true
  if (wp && isDoc(wp.queryPlan)) {
    const root = buildNode(wp.queryPlan, false)
    if (exec) {
      const byId = sbeByPlanNode(exec)
      if (byId.size && isSbeStage(exec)) {
        walk(root, (n) => {
          const id = num(n.details.planNodeId)
          const stages = id !== undefined ? byId.get(id) : undefined
          if (stages?.length) n.stats = sbeStats(stages)
        })
      } else attachPositional(root, exec)
    }
    return root
  }
  if (exec) return buildNode(exec, true)
  if (wp && typeof wp.stage === 'string') return buildNode(wp, false)
  return node('EMPTY', {})
}

function shardTree(wp: Doc, exec: Doc | undefined, ctx: Ctx): PlanNode {
  const execShards = exec && Array.isArray(exec.shards) ? exec.shards.filter(isDoc) : []
  const children = (wp.shards as unknown[]).filter(isDoc).map((sh, i) => {
    const ex = execShards.find((e) => e.shardName !== undefined && e.shardName === sh.shardName) ?? execShards[i]
    const sub = planTree(isDoc(sh.winningPlan) ? sh.winningPlan : undefined, ex && isDoc(ex.executionStages) ? ex.executionStages : undefined, ctx)
    if (Array.isArray(sh.rejectedPlans)) ctx.rejected.push(...sh.rejectedPlans.filter(isDoc).map(rejectedTree))
    const label = str(sh.shardName) ?? `shard ${i + 1}`
    return node('SHARD', omit(sh, ['winningPlan', 'rejectedPlans']), [sub], ex ? statsOf(pickStats(ex)) : undefined, label)
  })
  return node(str(wp.stage) ?? 'SHARD_MERGE', omit(wp, ['shards']), children, exec ? statsOf(pickStats(exec)) : undefined)
}

function assignIds(n: PlanNode, id = '0'): void {
  n.id = id
  n.children.forEach((c, i) => assignIds(c, `${id}.${i}`))
}

export function findNode(root: PlanNode, id: string): PlanNode | undefined {
  let found: PlanNode | undefined
  walk(root, (n) => {
    if (n.id === id) found = n
  })
  return found
}

interface Info {
  qp?: Doc
  es?: Doc
  explainVersion?: string
  command?: Doc
}

function summarize(root: PlanNode, info: Info, ctx: Ctx): ExplainSummary {
  const { qp, es } = info
  const wp = isDoc(qp?.winningPlan) ? qp.winningPlan : undefined
  const shards = wp && Array.isArray(wp.shards) ? wp.shards.filter(isDoc) : []
  const first = shards[0]
  const indexes = new Set<string>()
  let collscan = false
  let inMemorySort = false
  let sortUsedDisk = false
  let fetch = false
  walk(root, (n) => {
    const s = n.stage
    const ix = str(n.details.indexName)
    if (ix) indexes.add(ix)
    else if (/IDHACK$/.test(s)) indexes.add('_id_')
    if (s === 'COLLSCAN') collscan = true
    if (s.toUpperCase() === 'SORT' || s === '$sort') {
      inMemorySort = true
      if (n.stats?.usedDisk) sortUsedDisk = true
    }
    if (s === 'FETCH' || s === 'COLLSCAN' || s === 'EXPRESS_IDHACK' || s === 'IDHACK' || s === 'seek' || s === 'scan') fetch = true
  })
  const parsedQuery = isDoc(qp?.parsedQuery) ? qp.parsedQuery : isDoc(first?.parsedQuery) ? first.parsedQuery : undefined
  const cmdFilter = isDoc(info.command?.filter) ? info.command.filter : undefined
  const filtered = Object.keys(parsedQuery ?? cmdFilter ?? {}).length > 0
  const hasStats = !!es
  const nReturned = num(es?.nReturned) ?? root.stats?.nReturned
  const docsExamined = num(es?.totalDocsExamined)
  const keysExamined = num(es?.totalKeysExamined)
  const timeMs = num(es?.executionTimeMillis)
  const ratio = hasStats && docsExamined !== undefined && nReturned !== undefined ? docsExamined / Math.max(nReturned, 1) : undefined
  const fwp = first && isDoc(first.winningPlan) ? first.winningPlan : undefined
  const rejectedPlans = Array.isArray(qp?.rejectedPlans) ? qp.rejectedPlans.length : ctx.rejected.length
  const s: ExplainSummary = {
    hasStats,
    engine: ctx.sbe || info.explainVersion === '2' ? 'sbe' : 'classic',
    sharded: shards.length > 0,
    shardCount: shards.length,
    namespace: str(qp?.namespace) ?? str(first?.namespace),
    explainVersion: info.explainVersion,
    nReturned,
    docsExamined,
    keysExamined,
    timeMs,
    ratio,
    indexes: [...indexes],
    collscan,
    inMemorySort,
    sortUsedDisk,
    covered: indexes.size > 0 && !fetch && !collscan,
    filtered,
    isCached: bool(wp?.isCached) ?? bool(fwp?.isCached),
    queryHash: str(qp?.planCacheShapeHash) ?? str(qp?.queryHash) ?? str(first?.planCacheShapeHash) ?? str(first?.queryHash),
    planCacheKey: str(qp?.planCacheKey) ?? str(first?.planCacheKey),
    indexFilterSet: bool(qp?.indexFilterSet) ?? bool(first?.indexFilterSet),
    rejectedPlans,
    executionSuccess: bool(es?.executionSuccess),
    errorMessage: str(es?.errorMessage),
    warnings: []
  }
  s.warnings = warningsFor(s)
  return s
}

export function warningsFor(s: ExplainSummary): ExplainWarning[] {
  const w: ExplainWarning[] = []
  if (s.executionSuccess === false) w.push({ kind: 'failed', text: `Execution failed${s.errorMessage ? `: ${s.errorMessage}` : ''}` })
  if (s.collscan && s.filtered) w.push({ kind: 'collscan', text: 'Collection scan on a filtered query: no index supports this filter.' })
  if (s.inMemorySort) w.push({ kind: 'sort', text: `In-memory sort: no index provides the requested order${s.sortUsedDisk ? ' (spilled to disk)' : ''}.` })
  if (s.ratio !== undefined && s.ratio > 10) {
    w.push({ kind: 'ratio', text: `${(s.docsExamined ?? 0).toLocaleString()} documents examined to return ${(s.nReturned ?? 0).toLocaleString()} (${s.ratio >= 100 ? Math.round(s.ratio) : s.ratio.toFixed(1)}× ratio).` })
  }
  return w
}

function parseStagesArray(doc: Doc): ParsedExplain {
  const ctx: Ctx = { sbe: false, rejected: [] }
  let inner: ParsedExplain | undefined
  let cursorDoc: Doc | undefined
  const nodes = (doc.stages as unknown[]).filter(isDoc).map((st) => {
    const name = Object.keys(st).find((k) => k.startsWith('$')) ?? str(st.stage) ?? '?'
    const spec = st[name]
    if (name === '$cursor' && isDoc(spec)) {
      cursorDoc = spec
      inner = parseExplain(spec)
      return inner.root
    }
    const raw = pickStats(st)
    return node(name, { [name]: spec }, [], Object.keys(raw).length ? statsOf(raw) : undefined)
  })
  if (!nodes.length) nodes.push(node('EMPTY', {}))
  for (let i = nodes.length - 1; i > 0; i--) nodes[i].children = [...nodes[i].children.filter((c) => !nodes.includes(c)), nodes[i - 1]]
  const root = nodes[nodes.length - 1]
  assignIds(root)
  if (inner) {
    ctx.sbe = inner.summary.engine === 'sbe'
    ctx.rejected = inner.rejected
  }
  const cursor = cursorDoc
  const summary = summarize(
    root,
    {
      qp: isDoc(cursor?.queryPlanner) ? cursor.queryPlanner : isDoc(doc.queryPlanner) ? doc.queryPlanner : undefined,
      es: isDoc(cursor?.executionStats) ? cursor.executionStats : isDoc(doc.executionStats) ? doc.executionStats : undefined,
      explainVersion: str(doc.explainVersion) ?? str(cursor?.explainVersion),
      command: isDoc(doc.command) ? doc.command : undefined
    },
    ctx
  )
  if (root.stats?.nReturned !== undefined) summary.nReturned = root.stats.nReturned
  if (!summary.hasStats && nodes.some((n) => n.stats)) summary.hasStats = true
  summary.warnings = warningsFor(summary)
  return { summary, root, rejected: ctx.rejected }
}

/** Sharded aggregation explain: `shards: { name: { stages | queryPlanner … } }`. */
function parseShardMap(doc: Doc): ParsedExplain {
  const parts = Object.entries(doc.shards as Doc)
    .filter(([, v]) => isDoc(v))
    .map(([name, v]) => ({ name, p: parseExplain(v as Doc) }))
  const root = node(str(doc.mergeType) ? `SHARD_MERGE (${doc.mergeType})` : 'SHARD_MERGE', omit(doc, ['shards']), parts.map(({ name, p }) => node('SHARD', { shardName: name }, [p.root], undefined, name)))
  assignIds(root)
  const subs = parts.map((x) => x.p.summary)
  const sum = (k: 'nReturned' | 'docsExamined' | 'keysExamined'): number | undefined => (subs.some((s) => s[k] !== undefined) ? subs.reduce((a, s) => a + (s[k] ?? 0), 0) : undefined)
  const base = summarize(root, { explainVersion: str(doc.explainVersion), command: isDoc(doc.command) ? doc.command : undefined }, { sbe: subs.some((s) => s.engine === 'sbe'), rejected: [] })
  const hasStats = subs.some((s) => s.hasStats)
  const nReturned = sum('nReturned')
  const docsExamined = sum('docsExamined')
  const summary: ExplainSummary = {
    ...base,
    hasStats,
    sharded: true,
    shardCount: parts.length,
    nReturned,
    docsExamined,
    keysExamined: sum('keysExamined'),
    timeMs: subs.reduce<number | undefined>((a, s) => (s.timeMs === undefined ? a : Math.max(a ?? 0, s.timeMs)), undefined),
    ratio: hasStats && docsExamined !== undefined && nReturned !== undefined ? docsExamined / Math.max(nReturned, 1) : undefined,
    filtered: subs.some((s) => s.filtered),
    rejectedPlans: subs.reduce((a, s) => a + s.rejectedPlans, 0)
  }
  summary.warnings = warningsFor(summary)
  return { summary, root, rejected: parts.flatMap((x) => x.p.rejected) }
}

/** Normalise any server's explain output into a plan tree and a summary. */
export function parseExplain(doc: Doc): ParsedExplain {
  if (Array.isArray(doc.stages)) return parseStagesArray(doc)
  if (isDoc(doc.shards) && !isDoc(doc.queryPlanner)) return parseShardMap(doc)
  const qp = isDoc(doc.queryPlanner) ? doc.queryPlanner : undefined
  const es = isDoc(doc.executionStats) ? doc.executionStats : undefined
  const ctx: Ctx = { sbe: false, rejected: [] }
  const root = planTree(isDoc(qp?.winningPlan) ? qp.winningPlan : undefined, es && isDoc(es.executionStages) ? es.executionStages : undefined, ctx)
  if (Array.isArray(qp?.rejectedPlans)) ctx.rejected.push(...qp.rejectedPlans.filter(isDoc).map(rejectedTree))
  assignIds(root)
  ctx.rejected.forEach((r, i) => assignIds(r, `r${i}`))
  const summary = summarize(root, { qp, es, explainVersion: str(doc.explainVersion), command: isDoc(doc.command) ? doc.command : undefined }, ctx)
  return { summary, root, rejected: ctx.rejected }
}
