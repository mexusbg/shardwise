import { z } from 'zod'
import type { Document, MongoClient } from 'mongodb'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { analyzeSchema, flattenFields } from '@shared/schema'
import type { Doc } from '@shared/api'
import type { ConnectionConfig } from '@shared/connection'
import type { McpLogEntry } from '@shared/mcpApi'
import * as ops from '../mongo/ops'
import { explainAggregate } from '../mongo/aggregation'
import { ejson, formatDocs, formatValue, parseDoc, parseDocs, parseValue, quote, shell, summarizeArgs } from './values'
import { captureBefore, recordUpdated, RAW } from '../changes/recorder'
import type { ChangeBatch, ConnRecorder } from '../changes/recorder'
import { ReadOnlyError } from '../mongo/readOnly'

export const READ_TOOLS = ['list_connections', 'list_databases', 'list_collections', 'collection_schema', 'find', 'aggregate', 'count', 'explain', 'list_indexes'] as const
export const WRITE_TOOLS = ['insert_documents', 'update_documents', 'delete_documents', 'create_index'] as const

const MAX_TIME_MS = 30_000
const MAX_INSERT = 1000

export interface ExposedConnection {
  id: string
  name: string
  host: string
  connected: boolean
  /** Writes are refused on this connection. */
  readOnly?: boolean
}

export interface WriteRequest {
  tool: string
  connection: string
  database: string
  collection: string
  operation: string
  summary: string
}

export type Decision = 'approved' | 'denied' | 'timeout'

/** What the tools need from the bridge. */
export interface ToolContext {
  options(): { maxDocs: number; allowWrites: boolean }
  exposed(): Promise<ExposedConnection[]>
  resolve(connection: string): Promise<{ client: MongoClient; config: ConnectionConfig }>
  approve(req: WriteRequest, client?: string): Promise<Decision>
  log(e: Omit<McpLogEntry, 'id' | 'time'>): void
  /** Change History recorder of a connection (writes are recorded when given). */
  recorder?(config: ConnectionConfig): ConnRecorder | undefined
}

interface Meta {
  approved?: boolean
}

const connection = z.string().min(1).describe('Connection name (or id) from list_connections')
const database = z.string().min(1).describe('Database name')
const collection = z.string().min(1).describe('Collection name')
const docInput = z.union([z.string(), z.record(z.string(), z.unknown())])
const filter = docInput
  .optional()
  .describe(
    'Query filter. Either a JSON object (Extended JSON wrappers allowed, e.g. {"_id": {"$oid": "65…"}, "createdAt": {"$gte": {"$date": "2024-01-01T00:00:00Z"}}}) or mongo shell text (e.g. "{ qty: { $gt: 5 }, _id: ObjectId(\'65…\') }"). Omit for all documents.'
  )
const pipelineInput = z
  .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
  .describe('Aggregation pipeline: an array of stage objects (Extended JSON allowed) or mongo shell text of the array.')

const WRITE_STAGES = ['$out', '$merge']

function writeStages(pipeline: Doc[]): string[] {
  return pipeline.flatMap((s) => Object.keys(s).filter((k) => WRITE_STAGES.includes(k)))
}

const coll = (client: MongoClient, db: string, c: string) => client.db(db).collection(c)
const target = (db: string, c: string): string => `db.getSiblingDB(${quote(db)}).getCollection(${quote(c)})`
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

const DENIED: Record<Exclude<Decision, 'approved'>, string> = {
  denied: 'The user denied this operation in Shardwise. Nothing was changed.',
  timeout: 'Nobody approved this operation in Shardwise in time, so it was denied. Nothing was changed.'
}

function slimExplain(e: Doc): Doc {
  const out = { ...e }
  for (const k of ['command', 'serverInfo', 'serverParameters', '$clusterTime', 'operationTime', 'ok']) delete out[k]
  return out
}

/** Registers every tool on a session's server. Write tools are registered disabled unless writes are allowed. */
export function registerTools(server: McpServer, ctx: ToolContext, clientName: () => string | undefined): RegisteredTool[] {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    cfg: { title: string; description: string; inputSchema: S; write?: boolean },
    fn: (a: z.infer<z.ZodObject<S>>, meta: Meta) => Promise<string>
  ): RegisteredTool => {
    const handler = async (a: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      const t0 = performance.now()
      const meta: Meta = {}
      const base = { client: clientName(), tool: name, args: summarizeArgs(a as Record<string, unknown>) }
      try {
        if (cfg.write && !ctx.options().allowWrites) throw new Error('Write tools are disabled in Shardwise (Settings → AI & automation → MCP server → Allow writes).')
        const text = await fn(a, meta)
        ctx.log({ ...base, ms: Math.round(performance.now() - t0), size: text.length, approved: meta.approved })
        return { content: [{ type: 'text', text }] }
      } catch (e) {
        const msg = (e as Error).message || String(e)
        ctx.log({ ...base, ms: Math.round(performance.now() - t0), error: msg, approved: meta.approved })
        return { content: [{ type: 'text', text: msg }], isError: true }
      }
    }
    return server.registerTool(
      name,
      {
        title: cfg.title,
        description: cfg.description,
        inputSchema: cfg.inputSchema,
        annotations: cfg.write
          ? { title: cfg.title, readOnlyHint: false, destructiveHint: name !== 'insert_documents' && name !== 'create_index', openWorldHint: false }
          : { title: cfg.title, readOnlyHint: true, openWorldHint: false }
      },
      handler as never
    )
  }

  const history = (config: ConnectionConfig, db: string, c: string, name: string): ChangeBatch | null =>
    ctx.recorder?.(config)?.begin(db, c, 'mcp', `MCP ${name}${clientName() ? ` (${clientName()})` : ''}`) ?? null

  /** One matching document (what updateOne / deleteOne would hit), pinned by _id so the capture matches the write. */
  const pinOne = async (c: ReturnType<typeof coll>, f: Doc, batch: ChangeBatch | null): Promise<{ filter: Doc; before: Doc[] | null }> => {
    if (!batch) return { filter: f, before: null }
    const d = (await c.findOne(f, RAW).catch(() => null)) as Doc | null
    return d ? { filter: { $and: [f, { _id: d._id }] }, before: [d] } : { filter: f, before: [] }
  }

  /** Resolves a connection for a write; read-only connections are refused before the user is asked to approve. */
  const forWrite = async (connection: string, action: string): Promise<{ client: MongoClient; config: ConnectionConfig }> => {
    const r = await ctx.resolve(connection)
    if (r.config.readOnly) throw new ReadOnlyError(r.config.name, action)
    return r
  }

  const approve = async (meta: Meta, req: WriteRequest): Promise<void> => {
    const d = await ctx.approve(req, clientName())
    meta.approved = d === 'approved'
    if (d !== 'approved') throw new Error(DENIED[d])
  }

  tool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'List the MongoDB connections Shardwise exposes to MCP clients: name, id, host and whether it is connected. Pass the name (or id) as `connection` to the other tools. Only connections the user marked "Expose to MCP clients" are listed.',
      inputSchema: {}
    },
    async () => {
      const list = await ctx.exposed()
      if (!list.length) return 'No connections are exposed. In Shardwise, edit a connection and tick "Expose to MCP clients" (Advanced tab).'
      return JSON.stringify(list, null, 1)
    }
  )

  tool(
    'list_databases',
    { title: 'List databases', description: 'List the databases of a connection with their size on disk (bytes).', inputSchema: { connection } },
    async (a) => {
      const { client, config } = await ctx.resolve(a.connection)
      return ejson(await ops.listDatabases(client, config))
    }
  )

  tool(
    'list_collections',
    { title: 'List collections', description: 'List the collections and views of a database.', inputSchema: { connection, database } },
    async (a) => {
      const { client } = await ctx.resolve(a.connection)
      return ejson(await ops.listCollections(client, a.database))
    }
  )

  tool(
    'collection_schema',
    {
      title: 'Collection schema',
      description:
        'Infer the schema of a collection from a random sample of documents: every field path (dotted; `[]` marks array elements) with its BSON types, the share of each type and how often the field is present. Use it before writing queries.',
      inputSchema: { connection, database, collection, sampleSize: z.number().int().min(1).max(1000).optional().describe('Documents to sample (default 100)') }
    },
    async (a) => {
      const { client } = await ctx.resolve(a.connection)
      const size = a.sampleSize ?? 100
      const docs = await coll(client, a.database, a.collection)
        .aggregate([{ $sample: { size } }], { ...ops.RAW_TYPES, maxTimeMS: MAX_TIME_MS })
        .toArray()
      const report = analyzeSchema(docs, { samples: 0, topValues: 0 })
      const fields = flattenFields(report.fields).map((f) => ({
        path: f.path,
        types: Object.fromEntries(
          f.types.map((t) => [t.array?.elementTypes.length ? `array<${t.array.elementTypes.map((x) => x.label).join('|')}>` : t.label, Math.round(t.pct * 100) / 100])
        ),
        presence: Math.round(f.presence * 100) / 100
      }))
      return formatValue({ namespace: `${a.database}.${a.collection}`, sampled: report.docCount, fields }).text
    }
  )

  tool(
    'find',
    {
      title: 'Find documents',
      description:
        'Query documents of a collection (like db.collection.find). Results are relaxed Extended JSON, capped at the Shardwise "max documents" setting and ~50 KB; use a projection for wide documents.',
      inputSchema: {
        connection,
        database,
        collection,
        filter,
        projection: docInput.optional().describe('Projection, e.g. {"name": 1, "_id": 0}'),
        sort: docInput.optional().describe('Sort, e.g. {"createdAt": -1}'),
        skip: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).optional().describe('Max documents (capped by the server setting)')
      }
    },
    async (a) => {
      const { client } = await ctx.resolve(a.connection)
      const max = ctx.options().maxDocs
      const limit = Math.min(a.limit ?? max, max)
      const f = parseDoc(a.filter, 'filter', {})
      const projection = a.projection === undefined ? undefined : parseDoc(a.projection, 'projection')
      const sort = a.sort === undefined ? undefined : parseDoc(a.sort, 'sort')
      const r = await ops.find(client, a.database, a.collection, { filter: f, projection, sort, skip: a.skip ?? 0, limit: limit + 1 }, MAX_TIME_MS)
      const more = r.docs.length > limit
      const docs = r.docs.slice(0, limit)
      const note = more ? ` (limit ${limit}${a.limit && a.limit > max ? `, the server caps results at ${max}` : ''}; more documents match — use skip to page)` : ''
      return formatDocs(`${plural(docs.length, 'document')}${note}`, docs).text
    }
  )

  tool(
    'aggregate',
    {
      title: 'Aggregate',
      description:
        'Run an aggregation pipeline on a collection. Results are relaxed Extended JSON, capped at the "max documents" setting and ~50 KB. Pipelines with $out or $merge are rejected unless the user allowed writes, and then each one needs the user\'s approval in Shardwise.',
      inputSchema: { connection, database, collection, pipeline: pipelineInput, allowDiskUse: z.boolean().optional() }
    },
    async (a, meta) => {
      const { client, config } = await ctx.resolve(a.connection)
      const pipeline = parseDocs(a.pipeline, 'pipeline')
      const writes = writeStages(pipeline)
      const c = coll(client, a.database, a.collection)
      if (writes.length) {
        if (!ctx.options().allowWrites) throw new Error(`${writes.join(' / ')} writes data; pipelines with $out / $merge are not allowed (Shardwise → Settings → AI & automation → MCP server → Allow writes).`)
        if (config.readOnly) throw new ReadOnlyError(config.name, `a pipeline with ${writes.join(' / ')}`)
        await approve(meta, {
          tool: 'aggregate',
          connection: config.name,
          database: a.database,
          collection: a.collection,
          operation: `${target(a.database, a.collection)}.aggregate(${shell(pipeline)})`,
          summary: `Run a pipeline that writes with ${writes.join(' / ')}`
        })
        await c.aggregate(pipeline as Document[], { allowDiskUse: a.allowDiskUse, maxTimeMS: MAX_TIME_MS }).toArray()
        return `Pipeline finished; its output was written by ${writes.join(' / ')}.`
      }
      const max = ctx.options().maxDocs
      const docs = await c
        .aggregate([...pipeline, { $limit: max + 1 }] as Document[], { ...ops.RAW_TYPES, allowDiskUse: a.allowDiskUse, maxTimeMS: MAX_TIME_MS })
        .toArray()
      const more = docs.length > max
      return formatDocs(`${plural(Math.min(docs.length, max), 'document')}${more ? ` (capped at ${max}; add $limit / $match or $group to narrow the result)` : ''}`, docs.slice(0, max)).text
    }
  )

  tool(
    'count',
    { title: 'Count documents', description: 'Count the documents matching a filter (exact count).', inputSchema: { connection, database, collection, filter } },
    async (a) => {
      const { client } = await ctx.resolve(a.connection)
      return String(await ops.count(client, a.database, a.collection, parseDoc(a.filter, 'filter', {}), MAX_TIME_MS))
    }
  )

  tool(
    'explain',
    {
      title: 'Explain',
      description:
        'Show the query plan of a find (filter / sort / projection / limit) or of an aggregation pipeline: which index is used, documents examined, etc. "executionStats" runs the query to collect statistics.',
      inputSchema: {
        connection,
        database,
        collection,
        filter,
        sort: docInput.optional(),
        projection: docInput.optional(),
        limit: z.number().int().min(0).optional(),
        pipeline: pipelineInput.optional().describe('Explain this aggregation pipeline instead of a find'),
        verbosity: z.enum(['queryPlanner', 'executionStats', 'allPlansExecution']).optional().describe('Default queryPlanner')
      }
    },
    async (a) => {
      const { client } = await ctx.resolve(a.connection)
      const verbosity = a.verbosity ?? 'queryPlanner'
      if (a.pipeline !== undefined) {
        const pipeline = parseDocs(a.pipeline, 'pipeline')
        if (writeStages(pipeline).length) throw new Error('Pipelines with $out / $merge cannot be explained through MCP.')
        return formatValue(slimExplain(await explainAggregate(client, a.database, a.collection, pipeline, {}, verbosity))).text
      }
      const req = {
        filter: parseDoc(a.filter, 'filter', {}),
        sort: a.sort === undefined ? undefined : parseDoc(a.sort, 'sort'),
        projection: a.projection === undefined ? undefined : parseDoc(a.projection, 'projection'),
        skip: 0,
        limit: a.limit ?? 0
      }
      return formatValue(slimExplain(await ops.explain(client, a.database, a.collection, req, verbosity))).text
    }
  )

  tool(
    'list_indexes',
    { title: 'List indexes', description: 'List the indexes of a collection (keys and options).', inputSchema: { connection, database, collection } },
    async (a) => {
      const { client } = await ctx.resolve(a.connection)
      return formatValue(await ops.listIndexes(client, a.database, a.collection)).text
    }
  )

  const writeNote = ' Requires "Allow writes" in Shardwise, and the user must approve each call in the app (denied after 60 s without an answer). Connections listed with readOnly: true refuse every write.'

  const insert = tool(
    'insert_documents',
    {
      title: 'Insert documents',
      write: true,
      description: `Insert documents into a collection.${writeNote}`,
      inputSchema: {
        connection,
        database,
        collection,
        documents: z
          .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
          .describe(`Documents to insert (max ${MAX_INSERT}): an array of objects (Extended JSON allowed) or mongo shell text of the array`)
      }
    },
    async (a, meta) => {
      const { client, config } = await forWrite(a.connection, 'insert_documents')
      const docs = parseDocs(a.documents, 'documents')
      if (!docs.length) throw new Error('documents is empty')
      if (docs.length > MAX_INSERT) throw new Error(`At most ${MAX_INSERT} documents per call`)
      await approve(meta, {
        tool: 'insert_documents',
        connection: config.name,
        database: a.database,
        collection: a.collection,
        operation: `${target(a.database, a.collection)}.insertMany(${shell(docs)})`,
        summary: `Insert ${plural(docs.length, 'document')}`
      })
      const batch = history(config, a.database, a.collection, 'insert_documents')
      const record = (ids: Record<number, unknown> | undefined): void => {
        if (batch && ids) batch.add(Object.entries(ids).map(([i, id]) => ({ op: 'insert', docId: id, after: { _id: id, ...docs[Number(i)] } })))
      }
      let r: { insertedCount: number; insertedIds: Record<number, unknown> }
      try {
        r = await coll(client, a.database, a.collection).insertMany(docs as Document[])
      } catch (e) {
        // A failed insertMany may still have written the documents before the error: record those too.
        record((e as { insertedIds?: Record<number, unknown> }).insertedIds)
        throw e
      }
      record(r.insertedIds)
      return ejson({ insertedCount: r.insertedCount, insertedIds: Object.values(r.insertedIds) })
    }
  )

  const update = tool(
    'update_documents',
    {
      title: 'Update documents',
      write: true,
      description: `Update documents matching a filter with update operators ($set, $unset, $inc…) or an update pipeline. Updates one document unless many is true.${writeNote}`,
      inputSchema: {
        connection,
        database,
        collection,
        filter: docInput.describe('Filter selecting the documents (JSON / Extended JSON object or mongo shell text). Required; use {} deliberately for all documents.'),
        update: z
          .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])
          .describe('Update document with operators, e.g. {"$set": {"status": "done"}}, or an update pipeline array'),
        many: z.boolean().optional().describe('Update every matching document (updateMany). Default false (updateOne).'),
        upsert: z.boolean().optional()
      }
    },
    async (a, meta) => {
      const { client, config } = await forWrite(a.connection, 'update_documents')
      const f = parseDoc(a.filter, 'filter')
      const u = parseValue(a.update, 'update')
      const isPipeline = Array.isArray(u)
      if (!isPipeline && (u === null || typeof u !== 'object')) throw new Error('update must be an object or a pipeline array')
      if (!isPipeline && !Object.keys(u as Doc).every((k) => k.startsWith('$'))) throw new Error('update must use update operators such as $set (replacing whole documents is not supported)')
      const method = a.many ? 'updateMany' : 'updateOne'
      const opts = a.upsert ? ', { upsert: true }' : ''
      await approve(meta, {
        tool: 'update_documents',
        connection: config.name,
        database: a.database,
        collection: a.collection,
        operation: `${target(a.database, a.collection)}.${method}(${shell(f)}, ${shell(u)}${opts})`,
        summary: a.many ? 'Update every matching document' : 'Update one matching document'
      })
      const c = coll(client, a.database, a.collection)
      const o = { upsert: !!a.upsert }
      const batch = history(config, a.database, a.collection, 'update_documents')
      const one = a.many ? null : await pinOne(c, f, batch)
      const before = a.many ? await captureBefore(c, f, batch, { allowWithoutHistory: true }) : one!.before
      const r = a.many ? await c.updateMany(f, u as Document, o) : await c.updateOne(one!.filter, u as Document, o)
      await recordUpdated(c, batch, before).catch(() => {})
      if (batch && r.upsertedId != null) batch.add([{ op: 'insert', docId: r.upsertedId }])
      const unrecorded = batch && !before && r.modifiedCount ? { changeHistory: 'Not recorded in Shardwise Change History: too many documents' } : {}
      return ejson({ matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, upsertedId: r.upsertedId ?? undefined, ...unrecorded })
    }
  )

  const del = tool(
    'delete_documents',
    {
      title: 'Delete documents',
      write: true,
      description: `Delete documents matching a filter. Deletes one document unless many is true.${writeNote}`,
      inputSchema: {
        connection,
        database,
        collection,
        filter: docInput.describe('Filter selecting the documents to delete. Required; {} with many=true deletes everything.'),
        many: z.boolean().optional().describe('Delete every matching document (deleteMany). Default false (deleteOne).')
      }
    },
    async (a, meta) => {
      const { client, config } = await forWrite(a.connection, 'delete_documents')
      const f = parseDoc(a.filter, 'filter')
      const c = coll(client, a.database, a.collection)
      const matching = a.many ? await c.countDocuments(f, { maxTimeMS: MAX_TIME_MS }).catch(() => -1) : -1
      await approve(meta, {
        tool: 'delete_documents',
        connection: config.name,
        database: a.database,
        collection: a.collection,
        operation: `${target(a.database, a.collection)}.${a.many ? 'deleteMany' : 'deleteOne'}(${shell(f)})`,
        summary: a.many ? (matching >= 0 ? `Delete ${plural(matching, 'matching document')}` : 'Delete every matching document') : 'Delete one matching document'
      })
      const batch = history(config, a.database, a.collection, 'delete_documents')
      const one = a.many ? null : await pinOne(c, f, batch)
      const before = a.many ? await captureBefore(c, f, batch, { allowWithoutHistory: true }) : one!.before
      const r = a.many ? await c.deleteMany(f) : await c.deleteOne(one!.filter)
      if (r.deletedCount) batch?.add((before ?? []).map((d) => ({ op: 'delete', before: d })))
      const unrecorded = batch && !before && r.deletedCount ? { changeHistory: 'Not recorded in Shardwise Change History: too many documents' } : {}
      return ejson({ deletedCount: r.deletedCount, ...unrecorded })
    }
  )

  const index = tool(
    'create_index',
    {
      title: 'Create index',
      write: true,
      description: `Create an index on a collection.${writeNote}`,
      inputSchema: {
        connection,
        database,
        collection,
        keys: docInput.describe('Index keys, e.g. {"status": 1, "createdAt": -1} or {"title": "text"}'),
        name: z.string().optional(),
        unique: z.boolean().optional(),
        sparse: z.boolean().optional(),
        expireAfterSeconds: z.number().int().min(0).optional().describe('TTL in seconds (single date field)'),
        partialFilterExpression: docInput.optional()
      }
    },
    async (a, meta) => {
      const { client, config } = await forWrite(a.connection, 'create_index')
      const keys = parseDoc(a.keys, 'keys')
      const options: Doc = {}
      if (a.name) options.name = a.name
      if (a.unique) options.unique = true
      if (a.sparse) options.sparse = true
      if (a.expireAfterSeconds !== undefined) options.expireAfterSeconds = a.expireAfterSeconds
      if (a.partialFilterExpression !== undefined) options.partialFilterExpression = parseDoc(a.partialFilterExpression, 'partialFilterExpression')
      await approve(meta, {
        tool: 'create_index',
        connection: config.name,
        database: a.database,
        collection: a.collection,
        operation: `${target(a.database, a.collection)}.createIndex(${shell(keys)}${Object.keys(options).length ? `, ${shell(options)}` : ''})`,
        summary: 'Create an index'
      })
      return `Created index ${await ops.createIndex(client, a.database, a.collection, keys, options)}`
    }
  )

  return [insert, update, del, index]
}
