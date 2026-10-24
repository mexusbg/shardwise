import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'http'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { EJSON, ObjectId } from 'bson'
import { MongoClient } from 'mongodb'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConnectionManager } from '../src/main/mongo/manager'
import { McpBridge, MCP_SERVER_VERSION } from '../src/main/mcp/server'
import type { McpStartOptions } from '../src/main/mcp/server'
import { READ_TOOLS, WRITE_TOOLS } from '../src/main/mcp/tools'
import { revive } from '../src/main/mcp/values'
import { McpService } from '../src/main/mcp/service'
import { newConnectionConfig, parseUri } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { ApprovalRequest, McpLogEntry } from '@shared/mcpApi'
import type { ChangeEntry, ConnRecorder } from '../src/main/changes/recorder'

const TOKEN = 'test-token-0123456789'
const DB = 'shop'

let server: MongoMemoryServer
let direct: MongoClient
let mgr: ConnectionManager
let configs: ConnectionConfig[]
let bridge: McpBridge
let url: string
let port: number
const approvals: ApprovalRequest[] = []
const logs: McpLogEntry[] = []
let decide: (r: ApprovalRequest) => Promise<boolean> = async () => false
const clients: Client[] = []
/** Change History entries handed to the bridge's recorder. */
const recorded: ChangeEntry[] = []
const recorder = (): ConnRecorder => ({
  begin: () => ({ id: 'b', cap: 1e6, remaining: 1e6, truncated: false, add: (es: ChangeEntry[]) => void recorded.push(...es), marker: () => {} })
})

const base: Omit<McpStartOptions, 'port'> = { token: TOKEN, allowWrites: false, maxDocs: 50, autoConnect: false }

async function connect(token = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  const client = new Client({ name: 'vitest-client', version: '1.2.3' })
  await client.connect(transport)
  clients.push(client)
  return client
}

interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult
}

const text = (r: ToolResult): string => r.content[0].text
/** Header line + relaxed EJSON array. */
const docsOf = (r: ToolResult): Record<string, unknown>[] => {
  const t = text(r)
  const body = t.slice(t.indexOf('\n') + 1).split('\n…')[0]
  return EJSON.parse(body, { relaxed: true }) as Record<string, unknown>[]
}

function raw(headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  direct = await MongoClient.connect(server.getUri())
  const items = Array.from({ length: 120 }, (_, i) => ({ _id: new ObjectId(), n: i, name: `item${i}`, qty: i % 10, tags: ['a', 'b'] }))
  await direct.db(DB).collection('items').insertMany(items)
  await direct.db(DB).collection('big').insertMany(Array.from({ length: 30 }, (_, i) => ({ i, blob: 'x'.repeat(5000) })))
  const mk = (id: string, name: string, expose: boolean): ConnectionConfig => ({ ...parseUri(server.getUri(), { ...newConnectionConfig(), id, name }), exposeToMcp: expose || undefined })
  configs = [mk('c1', 'Local', true), mk('c2', 'Hidden', false), mk('c3', 'Offline', true)]
  mgr = new ConnectionManager()
  await mgr.connect(configs[0])
  await mgr.connect(configs[1])
  bridge = new McpBridge(
    mgr,
    async () => configs,
    (r) => {
      approvals.push(r)
      return decide(r)
    },
    (e) => logs.push(e),
    recorder
  )
  const st = await bridge.start({ ...base, port: 0 })
  port = st.port!
  url = st.url!
})

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {})
  await bridge?.stop()
  await mgr?.closeAll()
  await direct?.close()
  await server?.stop()
})

describe('MCP bridge: transport security', () => {
  it('listens on loopback only', () => {
    expect(url).toBe(`http://127.0.0.1:${port}/mcp`)
    expect(bridge.status()).toMatchObject({ running: true, port })
  })

  it('rejects requests without or with a wrong bearer token', async () => {
    expect(await raw({ Host: `127.0.0.1:${port}` })).toBe(401)
    expect(await raw({ Host: `127.0.0.1:${port}`, Authorization: 'Bearer nope' })).toBe(401)
    expect(await raw({ Host: `127.0.0.1:${port}`, Authorization: `Basic ${TOKEN}` })).toBe(401)
    await expect(connect('wrong-token')).rejects.toThrow()
    expect(await raw({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` })).toBe(200)
  })

  it('rejects non-loopback Host and Origin headers (DNS rebinding)', async () => {
    expect(await raw({ Host: `evil.example:${port}`, Authorization: `Bearer ${TOKEN}` })).toBe(403)
    expect(await raw({ Host: `127.0.0.1:${port}`, Origin: 'http://evil.example', Authorization: `Bearer ${TOKEN}` })).toBe(403)
    expect(await raw({ Host: `localhost:${port}`, Origin: `http://localhost:${port}`, Authorization: `Bearer ${TOKEN}` })).toBe(200)
  })

  it('rejects unknown sessions and paths', async () => {
    expect(await raw({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': 'nope' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).toBe(404)
    expect(await raw({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).toBe(400)
  })
})

describe('MCP bridge: read tools', () => {
  let c: Client

  beforeAll(async () => {
    c = await connect()
  })

  it('lists only the read tools when writes are off', async () => {
    const tools = await c.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort())
    expect(tools.tools.find((t) => t.name === 'find')?.annotations?.readOnlyHint).toBe(true)
    expect(bridge.status().clients).toContain('vitest-client 1.2.3')
  })

  it('lists only exposed connections', async () => {
    const list = JSON.parse(text(await call(c, 'list_connections'))) as { id: string; name: string; host: string; connected: boolean }[]
    expect(list.map((x) => [x.name, x.connected])).toEqual([
      ['Local', true],
      ['Offline', false]
    ])
    expect(list[0].host).toMatch(/127\.0\.0\.1:\d+/)
    expect(JSON.stringify(list)).not.toContain('password')
  })

  it('refuses hidden and unopened connections', async () => {
    const hidden = await call(c, 'list_databases', { connection: 'Hidden' })
    expect(hidden.isError).toBe(true)
    expect(text(hidden)).toMatch(/No exposed connection/)
    const offline = await call(c, 'list_databases', { connection: 'Offline' })
    expect(offline.isError).toBe(true)
    expect(text(offline)).toMatch(/not connected/)
  })

  it('lists databases, collections and indexes', async () => {
    expect(text(await call(c, 'list_databases', { connection: 'Local' }))).toContain('"shop"')
    expect(text(await call(c, 'list_databases', { connection: 'c1' }))).toContain('"shop"')
    expect(text(await call(c, 'list_collections', { connection: 'local', database: DB }))).toContain('"items"')
    expect(text(await call(c, 'list_indexes', { connection: 'Local', database: DB, collection: 'items' }))).toContain('_id_')
  })

  it('finds with shell and Extended JSON filters and caps the limit', async () => {
    const r = await call(c, 'find', { connection: 'Local', database: DB, collection: 'items', filter: '{ qty: { $gte: 5 } }', sort: { n: 1 }, projection: '{ name: 1, n: 1, _id: 0 }', limit: 3 })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/^3 documents .*more documents match/)
    expect(docsOf(r)).toEqual([
      { n: 5, name: 'item5' },
      { n: 6, name: 'item6' },
      { n: 7, name: 'item7' }
    ])
    const capped = await call(c, 'find', { connection: 'Local', database: DB, collection: 'items', limit: 500 })
    expect(docsOf(capped)).toHaveLength(50)
    expect(text(capped)).toMatch(/caps results at 50/)
    const one = (await direct.db(DB).collection('items').findOne({ n: 42 }))!
    const byId = await call(c, 'find', { connection: 'Local', database: DB, collection: 'items', filter: { _id: { $oid: one._id.toHexString() } } })
    expect(docsOf(byId).map((d) => d.n)).toEqual([42])
    const byShellId = await call(c, 'find', { connection: 'Local', database: DB, collection: 'items', filter: `{ _id: ObjectId('${one._id.toHexString()}') }` })
    expect(docsOf(byShellId).map((d) => d.n)).toEqual([42])
    const bad = await call(c, 'find', { connection: 'Local', database: DB, collection: 'items', filter: '{ qty: ' })
    expect(bad.isError).toBe(true)
  })

  it('caps output at ~50 KB', async () => {
    const r = await call(c, 'find', { connection: 'Local', database: DB, collection: 'big' })
    expect(text(r).length).toBeLessThan(52_000)
    expect(text(r)).toMatch(/output capped at 50 KB: showing \d+ of 30 documents/)
  })

  it('aggregates, counts, explains and samples the schema', async () => {
    const agg = await call(c, 'aggregate', { connection: 'Local', database: DB, collection: 'items', pipeline: [{ $group: { _id: '$qty', c: { $sum: 1 } } }, { $sort: { _id: 1 } }] })
    expect(docsOf(agg)).toHaveLength(10)
    expect(docsOf(agg)[0]).toEqual({ _id: 0, c: 12 })
    const many = await call(c, 'aggregate', { connection: 'Local', database: DB, collection: 'items', pipeline: '[{ $match: {} }]' })
    expect(docsOf(many)).toHaveLength(50)
    expect(text(many)).toMatch(/capped at 50/)
    expect(text(await call(c, 'count', { connection: 'Local', database: DB, collection: 'items', filter: { qty: 3 } }))).toBe('12')
    expect(text(await call(c, 'count', { connection: 'Local', database: DB, collection: 'items' }))).toBe('120')
    const ex = await call(c, 'explain', { connection: 'Local', database: DB, collection: 'items', filter: { qty: 3 }, verbosity: 'executionStats' })
    expect(text(ex)).toContain('queryPlanner')
    expect(text(ex)).toContain('executionStats')
    const exAgg = await call(c, 'explain', { connection: 'Local', database: DB, collection: 'items', pipeline: [{ $match: { qty: 3 } }] })
    expect(exAgg.isError).toBeFalsy()
    const schema = JSON.parse(text(await call(c, 'collection_schema', { connection: 'Local', database: DB, collection: 'items' }))) as {
      sampled: number
      fields: { path: string; types: Record<string, number>; presence: number }[]
    }
    expect(schema.sampled).toBe(100)
    expect(schema.fields.find((f) => f.path === 'name')).toEqual({ path: 'name', types: { String: 1 }, presence: 1 })
    expect(Object.keys(schema.fields.find((f) => f.path === 'tags')!.types)[0]).toMatch(/^array<String>/)
  })

  it('rejects $out / $merge when writes are off', async () => {
    const r = await call(c, 'aggregate', { connection: 'Local', database: DB, collection: 'items', pipeline: [{ $match: {} }, { $out: 'copy' }] })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/\$out/)
    const m = await call(c, 'aggregate', { connection: 'Local', database: DB, collection: 'items', pipeline: [{ $merge: { into: 'copy' } }] })
    expect(m.isError).toBe(true)
    expect((await direct.db(DB).listCollections({ name: 'copy' }).toArray()).length).toBe(0)
    expect(approvals).toHaveLength(0)
  })

  it('auto-connects exposed connections when enabled', async () => {
    await bridge.start({ ...base, port, autoConnect: true })
    const r = await call(c, 'count', { connection: 'Offline', database: DB, collection: 'items' })
    expect(text(r)).toBe('120')
    expect(mgr.liveConnections().map((l) => l.configId)).toContain('c3')
    await bridge.start({ ...base, port, autoConnect: false })
    expect(mgr.liveConnections().map((l) => l.configId)).not.toContain('c3')
  })

  it('logs every call with client and argument summary', () => {
    const e = logs.find((l) => l.tool === 'find')!
    expect(e.client).toBe('vitest-client 1.2.3')
    expect(e.args).toContain('connection=Local')
    expect(e.size).toBeGreaterThan(0)
    expect(logs.some((l) => l.error)).toBe(true)
  })
})

describe('MCP bridge: write tools', () => {
  let c: Client

  beforeAll(async () => {
    await bridge.start({ ...base, port, allowWrites: true, approvalTimeoutMs: 400 })
    c = await connect()
  })

  it('registers write tools only when writes are allowed', async () => {
    const names = (await c.listTools()).tools.map((t) => t.name)
    for (const w of WRITE_TOOLS) expect(names).toContain(w)
  })

  it('executes an approved insert and shows the exact operation', async () => {
    approvals.length = 0
    decide = async () => true
    const r = await call(c, 'insert_documents', { connection: 'Local', database: DB, collection: 'notes', documents: [{ title: 'hello', at: { $date: '2024-01-01T00:00:00Z' } }, { title: 'world' }] })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('"insertedCount":2')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ tool: 'insert_documents', connection: 'Local', database: DB, collection: 'notes', client: 'vitest-client 1.2.3', summary: 'Insert 2 documents' })
    expect(approvals[0].operation).toMatch(/^db\.getSiblingDB\('shop'\)\.getCollection\('notes'\)\.insertMany\(/)
    expect(approvals[0].operation).toContain('ISODate(')
    const saved = await direct.db(DB).collection('notes').findOne({ title: 'hello' })
    expect(saved?.at).toBeInstanceOf(Date)
    expect(logs.at(-1)).toMatchObject({ tool: 'insert_documents', approved: true })
  })

  it('does nothing when denied', async () => {
    decide = async () => false
    const r = await call(c, 'delete_documents', { connection: 'Local', database: DB, collection: 'items', filter: {}, many: true })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/denied/)
    expect(approvals.at(-1)?.summary).toBe('Delete 120 matching documents')
    expect(await direct.db(DB).collection('items').countDocuments()).toBe(120)
    expect(logs.at(-1)).toMatchObject({ tool: 'delete_documents', approved: false })
  })

  it('denies when nobody answers in time', async () => {
    decide = () => new Promise(() => {})
    const t0 = Date.now()
    const r = await call(c, 'update_documents', { connection: 'Local', database: DB, collection: 'items', filter: '{ n: 1 }', update: { $set: { name: 'changed' } } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/in time/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350)
    expect(approvals.at(-1)!.expiresAt).toBeGreaterThan(t0)
    expect((await direct.db(DB).collection('items').findOne({ n: 1 }))?.name).toBe('item1')
  })

  it('runs approved updates, deletes, index builds and $out pipelines', async () => {
    decide = async () => true
    const u = await call(c, 'update_documents', { connection: 'Local', database: DB, collection: 'notes', filter: { title: 'world' }, update: '{ $set: { done: true } }' })
    expect(text(u)).toContain('"modifiedCount":1')
    expect(approvals.at(-1)?.operation).toContain('.updateOne(')
    const bad = await call(c, 'update_documents', { connection: 'Local', database: DB, collection: 'notes', filter: {}, update: { title: 'replace' } })
    expect(bad.isError).toBe(true)
    const ix = await call(c, 'create_index', { connection: 'Local', database: DB, collection: 'notes', keys: { title: 1 }, unique: true })
    expect(text(ix)).toBe('Created index title_1')
    expect(approvals.at(-1)?.operation).toContain('.createIndex({')
    const out = await call(c, 'aggregate', { connection: 'Local', database: DB, collection: 'items', pipeline: [{ $match: { qty: 0 } }, { $out: 'zeros' }] })
    expect(out.isError).toBeFalsy()
    expect(await direct.db(DB).collection('zeros').countDocuments()).toBe(12)
    const d = await call(c, 'delete_documents', { connection: 'Local', database: DB, collection: 'notes', filter: { title: 'hello' } })
    expect(text(d)).toContain('"deletedCount":1')
  })

  it('records the documents a failed insert wrote before the error', async () => {
    decide = async () => true
    await direct.db(DB).collection('dupes').insertOne({ _id: 2 } as never)
    recorded.length = 0
    const r = await call(c, 'insert_documents', { connection: 'Local', database: DB, collection: 'dupes', documents: [{ _id: 1 }, { _id: 2 }, { _id: 3 }] })
    expect(r.isError).toBe(true)
    expect(await direct.db(DB).collection('dupes').countDocuments()).toBe(2)
    expect(recorded.map((e) => [e.op, Number(e.docId)])).toEqual([['insert', 1]])
  })

  it('hides write tools again when writes are turned off', async () => {
    await bridge.start({ ...base, port, allowWrites: false })
    const names = (await c.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('insert_documents')
    const r = await call(c, 'insert_documents', { connection: 'Local', database: DB, collection: 'notes', documents: [{ a: 1 }] })
    expect(r.isError).toBe(true)
  })
})

describe('MCP values', () => {
  it('revives Extended JSON wrappers but keeps query operators', () => {
    const v = revive({ _id: { $oid: '650000000000000000000001' }, name: { $regex: 'a', $options: 'i', $ne: 'b' }, t: { $type: 'string' } }) as Record<string, unknown>
    expect(v._id).toBeInstanceOf(ObjectId)
    expect(v.name).toEqual({ $regex: 'a', $options: 'i', $ne: 'b' })
    expect(v.t).toEqual({ $type: 'string' })
  })
})

describe('MCP bridge: stop', () => {
  it('closes the port', async () => {
    await bridge.stop()
    expect(bridge.status().running).toBe(false)
    await expect(raw({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()
  })
})

describe('MCP service', () => {
  it('persists settings with an encrypted token and answers approvals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-svc-'))
    const codec = { encrypt: async (v: string) => `sealed:${Buffer.from(v).toString('hex')}`, decrypt: async (v: string) => Buffer.from(v.slice(7), 'hex').toString() }
    const events: string[] = []
    const svc = new McpService(dir, codec, mgr, async () => configs, (ch) => void events.push(ch))
    try {
      const st = await svc.status()
      expect(st).toMatchObject({ running: false, settings: { enabled: false, port: 27999, allowWrites: false, maxDocs: 50, autoConnect: false } })
      expect(st.token.length).toBeGreaterThanOrEqual(40)
      const file = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as Record<string, unknown>
      expect(file.token).toMatch(/^sealed:/)
      expect(JSON.stringify(file)).not.toContain(st.token)
      const on = await svc.configure({ port: 0, maxDocs: 5000 })
      expect(on.settings.port).toBe(27999)
      expect(on.settings.maxDocs).toBe(1000)
      const again = await svc.regenerateToken()
      expect(again.token).not.toBe(st.token)
      const reloaded = new McpService(dir, codec, mgr, async () => configs, () => {})
      expect((await reloaded.status()).token).toBe(again.token)
    } finally {
      await svc.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MCP server version', () => {
  it('matches the app version in package.json', () => {
    expect(MCP_SERVER_VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version)
  })
})
