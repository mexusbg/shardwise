import type { MongoClient } from 'mongodb'
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { isPlainDoc, parseShellValue } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import * as ops from '../mongo/ops'
import * as aggregation from '../mongo/aggregation'
import { capText, describeSchema, docsText, explainText, sampleDocs } from './context'
import { MAX_TOOL_DOCS } from './settings'

const TOOL_TIMEOUT_MS = 15000

const str = (description: string): { type: 'string'; description: string } => ({ type: 'string', description })
const DB = str('Database name. Use the current database from the context unless the user means another one.')
const COLL = str('Collection name.')
const FILTER = str("Query filter in mongo shell syntax, e.g. { status: 'A', qty: { $gt: 5 } }. Use {} for all documents.")

function tool(name: string, description: string, properties: Record<string, unknown>): BetaTool {
  return {
    name,
    description,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    strict: true
  }
}

/** Read-only tools for the assistant. Arguments are shell-syntax strings so BSON types survive. */
export const ASSISTANT_TOOLS: BetaTool[] = [
  tool('list_databases', 'List the databases on the current connection with their sizes.', {}),
  tool('list_collections', 'List the collections and views of a database.', { db: DB }),
  tool(
    'collection_schema',
    'Sample up to 100 documents and report every field path with its BSON types and how often it is present. Returns no values. Use this before writing a query against an unfamiliar collection.',
    { db: DB, collection: COLL }
  ),
  tool('find', 'Run a read-only find query. Returns at most the configured number of documents (relaxed Extended JSON, long values shortened).', {
    db: DB,
    collection: COLL,
    filter: FILTER,
    projection: str("Projection in shell syntax, e.g. { name: 1, _id: 0 }, or '' for none."),
    sort: str("Sort in shell syntax, e.g. { createdAt: -1 }, or '' for none."),
    limit: { type: 'integer', description: `Maximum documents to return (1-${MAX_TOOL_DOCS}; capped by the user's setting).` }
  }),
  tool(
    'aggregate',
    'Run a read-only aggregation pipeline. $out and $merge are rejected. Returns at most the configured number of documents; add $limit / $project to keep results small.',
    { db: DB, collection: COLL, pipeline: str("Pipeline array in shell syntax, e.g. [ { $match: { status: 'A' } }, { $group: { _id: '$type', n: { $sum: 1 } } } ].") }
  ),
  tool('count', 'Count the documents matching a filter.', { db: DB, collection: COLL, filter: FILTER }),
  tool('explain', 'Explain how MongoDB executes a find (or an aggregation pipeline) with execution stats: indexes used, documents examined, sorts.', {
    db: DB,
    collection: COLL,
    filter: FILTER,
    sort: str("Sort in shell syntax or ''."),
    projection: str("Projection in shell syntax or ''."),
    pipeline: str("Pipeline to explain instead of a find (shell syntax), or '' to explain the find.")
  })
]

export const TOOL_NAMES = ASSISTANT_TOOLS.map((t) => t.name)

export interface ToolRun {
  ok: boolean
  /** Text sent back to the model. */
  content: string
  /** One-line summary for the tool card. */
  summary: string
}

export class ReadOnlyError extends Error {}

/** Stage operators that write. Nested pipelines ($lookup, $facet, $unionWith) are searched too. */
const WRITE_STAGES = new Set(['$out', '$merge'])

export function findWriteStage(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const w = findWriteStage(x)
      if (w) return w
    }
    return null
  }
  if (isPlainDoc(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (WRITE_STAGES.has(k)) return k
      const w = findWriteStage(x)
      if (w) return w
    }
  }
  return null
}

/** Parses an aggregation pipeline argument and rejects writes. */
export function readOnlyPipeline(text: string): Doc[] {
  const v = parseArg(text, 'pipeline')
  if (!Array.isArray(v)) throw new Error('pipeline must be an array of stages')
  v.forEach((st, i) => {
    if (!isPlainDoc(st) || Object.keys(st).length !== 1 || !Object.keys(st)[0].startsWith('$')) throw new Error(`Stage ${i + 1} must be an object with one $operator key`)
  })
  const w = findWriteStage(v)
  if (w) throw new ReadOnlyError(`${w} writes data and is not allowed: the assistant can only read.`)
  return v as Doc[]
}

function parseArg(text: unknown, what: string): unknown {
  if (typeof text !== 'string') throw new Error(`${what} must be a string`)
  try {
    return parseShellValue(text)
  } catch (e) {
    throw new Error(`Invalid ${what}: ${(e as Error).message}`)
  }
}

function docArg(text: unknown, what: string, optional: boolean): Doc | null {
  if (optional && (typeof text !== 'string' || !text.trim() || text.trim() === '{}')) return null
  if (!optional && typeof text === 'string' && !text.trim()) return {}
  const v = parseArg(text, what)
  if (!isPlainDoc(v)) throw new Error(`${what} must be an object`)
  if (findWriteStage(v)) throw new ReadOnlyError(`${what} cannot contain $out or $merge.`)
  return v
}

const name = (v: unknown, fallback: string | undefined, what: string): string => {
  const s = typeof v === 'string' && v.trim() ? v.trim() : fallback
  if (!s) throw new Error(`${what} is required`)
  return s
}

export interface ToolEnv {
  client: () => MongoClient
  db?: string
  coll?: string
  maxDocs: number
}

const plural = (n: number, w: string): string => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

/** Executes one tool call. Failures come back as `ok: false` (sent with is_error) rather than throwing. */
export async function runTool(toolName: string, input: Record<string, unknown>, env: ToolEnv): Promise<ToolRun> {
  try {
    return await execute(toolName, input, env)
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return { ok: false, content: `Error: ${msg}`, summary: msg.length > 160 ? `${msg.slice(0, 160)}…` : msg }
  }
}

async function execute(toolName: string, input: Record<string, unknown>, env: ToolEnv): Promise<ToolRun> {
  const maxDocs = Math.max(1, Math.min(env.maxDocs, MAX_TOOL_DOCS))
  switch (toolName) {
    case 'list_databases': {
      const dbs = await ops.listDatabases(env.client())
      const text = dbs.map((d) => `${d.name}${d.sizeOnDisk !== undefined ? ` (${Math.round(d.sizeOnDisk / 1024)} KB)` : ''}`).join('\n')
      return { ok: true, content: capText(text || '(no databases visible)'), summary: plural(dbs.length, 'database') }
    }
    case 'list_collections': {
      const db = name(input.db, env.db, 'db')
      const colls = await ops.listCollections(env.client(), db)
      const text = colls.map((c) => (c.type === 'collection' ? c.name : `${c.name} (${c.type})`)).join('\n')
      return { ok: true, content: capText(text || `(no collections in ${db})`), summary: plural(colls.length, 'collection') }
    }
    case 'collection_schema': {
      const db = name(input.db, env.db, 'db')
      const coll = name(input.collection, env.coll, 'collection')
      const docs = await sampleDocs(env.client(), db, coll, 100)
      const text = docs.length ? `${docs.length} sampled documents. path: types (presence when < 100%)\n${describeSchema(docs, 400)}` : `${db}.${coll} is empty or does not exist.`
      return { ok: true, content: capText(text), summary: docs.length ? `${plural(docs.length, 'document')} sampled` : 'empty collection' }
    }
    case 'find': {
      const db = name(input.db, env.db, 'db')
      const coll = name(input.collection, env.coll, 'collection')
      const filter = docArg(input.filter, 'filter', false) ?? {}
      const projection = docArg(input.projection, 'projection', true)
      const sort = docArg(input.sort, 'sort', true)
      const asked = Math.floor(Number(input.limit)) || maxDocs
      const limit = Math.max(1, Math.min(asked, maxDocs))
      const r = await ops.find(env.client(), db, coll, { filter, projection, sort, skip: 0, limit: limit + 1 }, TOOL_TIMEOUT_MS)
      return docsResult(r.docs, limit, `${db}.${coll}`)
    }
    case 'aggregate': {
      const db = name(input.db, env.db, 'db')
      const coll = name(input.collection, env.coll, 'collection')
      const pipeline = readOnlyPipeline(String(input.pipeline ?? ''))
      const r = await aggregation.aggregate(env.client(), db, coll, [...pipeline, { $limit: maxDocs + 1 }], { maxTimeMS: TOOL_TIMEOUT_MS })
      return docsResult(r.docs, maxDocs, `${db}.${coll}`)
    }
    case 'count': {
      const db = name(input.db, env.db, 'db')
      const coll = name(input.collection, env.coll, 'collection')
      const filter = docArg(input.filter, 'filter', false) ?? {}
      const n = await ops.count(env.client(), db, coll, filter, TOOL_TIMEOUT_MS)
      return { ok: true, content: String(n), summary: plural(n, 'document') }
    }
    case 'explain': {
      const db = name(input.db, env.db, 'db')
      const coll = name(input.collection, env.coll, 'collection')
      const pipelineText = typeof input.pipeline === 'string' ? input.pipeline.trim() : ''
      const doc = pipelineText
        ? await aggregation.explainAggregate(env.client(), db, coll, readOnlyPipeline(pipelineText), { maxTimeMS: TOOL_TIMEOUT_MS }, 'executionStats')
        : await ops.explain(
            env.client(),
            db,
            coll,
            { filter: docArg(input.filter, 'filter', false) ?? {}, projection: docArg(input.projection, 'projection', true), sort: docArg(input.sort, 'sort', true), skip: 0, limit: 0 },
            'executionStats'
          )
      const text = explainText(doc)
      return { ok: true, content: text, summary: text.split('\n')[2] ?? 'explained' }
    }
    default:
      throw new Error(`Unknown tool ${toolName}`)
  }
}

function docsResult(docs: Doc[], limit: number, ns: string): ToolRun {
  const more = docs.length > limit
  const { text, shown, truncated } = docsText(docs, limit)
  let content = text || `(no documents in ${ns} match)`
  if (more || truncated) content += `\n… showing ${shown} document${shown === 1 ? '' : 's'}; more match (results are capped).`
  return { ok: true, content, summary: `${plural(shown, 'document')}${more || truncated ? ' (capped)' : ''}` }
}
