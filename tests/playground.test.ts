import { resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Double, Int32, ObjectId } from 'bson'
import { MongoClient } from 'mongodb'
import { build } from 'rolldown'
import { parseUri } from '@shared/connection'
import type { PlaygroundLanguage, PlaygroundLog, PlaygroundResult } from '@shared/api'
import { ConnectionManager } from '../src/main/mongo/manager'
import { execute } from '../src/main/playground/core'
import { Playground } from '../src/main/playground/runner'
import type { ExecResult } from '../src/main/playground/protocol'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let connId: string
const workerFile = resolve(__dirname, '../node_modules/.cache/shardwise-playground-test/playgroundWorker.js')
const DB = 'shop'

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client
    .db(DB)
    .collection('items')
    .insertMany([
      { _id: new ObjectId('650000000000000000000001'), name: 'a', qty: new Int32(1), price: new Double(2.0) },
      { _id: new ObjectId('650000000000000000000002'), name: 'b', qty: new Int32(5), price: new Double(2.5) },
      { _id: new ObjectId('650000000000000000000003'), name: 'c', qty: new Int32(9), price: new Double(3.0) }
    ])
  await client.db('other').collection('people').insertOne({ name: 'zed' })
  mgr = new ConnectionManager()
  connId = (await mgr.connect(parseUri(server.getUri()))).connId
  // Bundle the worker like electron-vite does (dependencies stay external and resolve from node_modules).
  await build({
    input: resolve(__dirname, '../src/main/playground/worker.ts'),
    platform: 'node',
    resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
    external: (id) => !id.startsWith('.') && !id.startsWith('@shared') && !/^([a-zA-Z]:)?[\\/]/.test(id),
    logLevel: 'silent',
    output: { file: workerFile, format: 'cjs' }
  })
})

afterAll(async () => {
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
})

async function run(code: string, language: PlaygroundLanguage = 'javascript', db = DB): Promise<ExecResult & { logs: PlaygroundLog[] }> {
  const logs: PlaygroundLog[] = []
  const r = await execute({ client, db, code, language, onLog: (l) => logs.push(l) })
  return { ...r, logs }
}

describe('playground execution core', () => {
  it('returns the value of the last expression', async () => {
    const r = await run('const a = 1\n1 + a')
    expect(r).toMatchObject({ ok: true, value: 2, valueKind: 'value' })
    expect((await run('const x = 5')).valueKind).toBe('undefined')
    expect(await run('({ a: 1, b: [1, 2] })')).toMatchObject({ value: { a: 1, b: [1, 2] }, valueKind: 'document' })
  })

  it('waits for promises of top-level statements, like mongosh', async () => {
    expect((await run(['let done = false', 'sleep(20).then(() => { done = true })', 'done'].join('\n'))).value).toBe(true)
    // Statements inside blocks and functions keep normal JavaScript semantics.
    expect((await run(['let n = 0', 'if (true) { sleep(20).then(() => { n = 1 }) }', 'n'].join('\n'))).value).toBe(0)
  })

  it('supports top-level await and return', async () => {
    expect((await run('const v = await Promise.resolve(41)\nreturn v + 1\n"unreached"')).value).toBe(42)
    expect((await run('await sleep(5)\nif (true) return "early"\n"late"')).value).toBe('early')
  })

  it('runs TypeScript with types and interfaces', async () => {
    const code = [
      'interface Item { name: string; qty: number }',
      'type Q = { qty: number }',
      'const docs: Item[] = await db.items.find({}, { _id: 0 }).sort({ name: 1 }).toArray() as any',
      'function names(list: Item[]): string[] { return list.map((d) => d.name) }',
      'names(docs).join(",") as string'
    ].join('\n')
    expect(await run(code, 'typescript')).toMatchObject({ ok: true, value: 'a,b,c' })
  })

  it('streams console output', async () => {
    const r = await run('console.log("hello", { n: 1 })\nconsole.warn("careful")\nprint("p")\nconsole.error(new Error("bad"))\nundefined')
    expect(r.logs.map((l) => l.level)).toEqual(['log', 'warn', 'log', 'error'])
    expect(r.logs[0].text).toMatch(/^hello \{/)
    expect(r.logs[1].text).toBe('careful')
    expect(r.logs[3].text).toMatch(/Error: bad/)
    expect(r.valueKind).toBe('undefined')
  })

  it('awaits a mongosh-style cursor as the last expression and keeps BSON types', async () => {
    const r = await run('db.items.find({ qty: { $gte: 5 } }).sort({ qty: -1 }).limit(5)')
    expect(r.ok).toBe(true)
    expect(r.valueKind).toBe('documents')
    const docs = r.value as Record<string, unknown>[]
    expect(docs.map((d) => d.name)).toEqual(['c', 'b'])
    expect((docs[0].qty as Int32)._bsontype).toBe('Int32')
    expect((docs[0].price as Double)._bsontype).toBe('Double')
    expect((docs[0]._id as ObjectId).toHexString()).toBe('650000000000000000000003')
    expect(await run('db.items.findOne({ name: "b" }, { _id: 0, name: 1 })')).toMatchObject({ valueKind: 'document', value: { name: 'b' } })
    expect((await run('db.getCollection("items").countDocuments({ qty: { $gt: 1 } })')).value).toBe(2)
    expect((await run('db.items.aggregate([{ $group: { _id: null, n: { $sum: "$qty" } } }])')).value).toEqual([{ _id: null, n: new Int32(15) }])
    expect((await run('(await db.items.find().toArray()).length')).value).toBe(3)
  })

  it('lists collections and switches databases', async () => {
    expect((await run('db.getCollectionNames()')).value).toEqual(['items'])
    expect((await run('use("other")\ndb.getName() + ":" + (await db.getCollectionNames()).join()')).value).toBe('other:people')
    expect((await run('db.getSiblingDB("other").people.findOne({}, { _id: 0 })')).value).toEqual({ name: 'zed' })
  })

  it('maps capitalised identifiers to schemaless Mongoose models', async () => {
    const r = await run('Item.find({ qty: { $gt: 1 } }).sort({ name: 1 }).lean()')
    expect(r.ok).toBe(true)
    expect(r.valueKind).toBe('documents')
    expect((r.value as { name: string }[]).map((d) => d.name)).toEqual(['b', 'c'])
    // Hydrated documents are converted to plain objects.
    const h = await run('await Item.findOne({ name: "a" })')
    expect(h).toMatchObject({ ok: true, valueKind: 'document', value: { name: 'a' } })
    expect((await run('Item.collection.collectionName')).value).toBe('items')
    expect((await run('use("other")\nawait Person.countDocuments()')).value).toBe(1)
  })

  it('supports explicitly defined models', async () => {
    const code = "const Thing = model('Thing', new Schema({ name: String }), 'items')\nawait Thing.find().sort({ name: -1 }).select('name -_id').lean()"
    expect((await run(code)).value).toEqual([{ name: 'c' }, { name: 'b' }, { name: 'a' }])
    const viaMongoose = "mongoose.model('Gadget', new mongoose.Schema({ qty: Number }), 'items')\nGadget.countDocuments({ qty: { $lt: 6 } })"
    expect((await run(viaMongoose)).value).toBe(2)
  })

  it('reports syntax errors with the line number', async () => {
    const r = await run('const a = 1\nconst b = (\nconsole.log(a)\n}')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^SyntaxError: .*\(line 4/)
    expect(r.stack).toContain('> 4 | }')
    const ts = await run('const a: number = 1\nlet b: = 2', 'typescript')
    expect(ts.error).toMatch(/SyntaxError: .*\(line 2/)
  })

  it('reports runtime errors with the user line', async () => {
    const r = await run('const a = 1\n\nnull.foo()')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^TypeError: .*\(line 3\)$/)
    expect(r.stack).toContain('playground.js:3')
    // Columns on the rewritten last line map back to the user's code.
    expect((await run('const x = {}\nx.missing.field')).stack).toContain('playground.js:2:11')
    const m = await run('await db.items.insertOne({ _id: ObjectId("650000000000000000000001") })')
    expect(m.error).toMatch(/duplicate key/)
    expect((await run('require("fs")')).error).toMatch(/require is not defined/)
    expect((await run('process.exit(1)')).error).toMatch(/process is not defined/)
  })

  it('provides shell helpers and BSON constructors', async () => {
    const r = await run('({ id: ObjectId("650000000000000000000009"), n: NumberLong("5"), i: NumberInt(3), d: ISODate("2024-01-02T00:00:00Z"), dec: NumberDecimal("1.5") })')
    const v = r.value as Record<string, { _bsontype?: string }>
    expect(v.id._bsontype).toBe('ObjectId')
    expect(v.n._bsontype).toBe('Long')
    expect(v.i._bsontype).toBe('Int32')
    expect(v.dec._bsontype).toBe('Decimal128')
    expect((v.d as unknown as Date).toISOString()).toBe('2024-01-02T00:00:00.000Z')
  })

  it('caps large array results', async () => {
    const r = await run('Array.from({ length: 1500 }, (_, i) => ({ i }))')
    expect(r.valueKind).toBe('documents')
    expect((r.value as unknown[]).length).toBe(1000)
    expect(r.logs.some((l) => /first 1000 of 1500/.test(l.text))).toBe(true)
  })
})

describe('playground worker', () => {
  const runWorker = (code: string, timeoutMS = 0, logs: PlaygroundLog[] = []): { pg: Playground; runId: string; done: Promise<PlaygroundResult> } => {
    const pg = new Playground(mgr, (_id, l) => logs.push(l), workerFile)
    const runId = `r${Math.random()}`
    return { pg, runId, done: pg.run({ runId, connId, db: DB, code, language: 'javascript', timeoutMS }) }
  }

  it('runs code in a worker thread with its own client', async () => {
    const logs: PlaygroundLog[] = []
    const r = await runWorker('console.log("from worker")\ndb.items.find({}, { name: 1 }).sort({ qty: 1 }).limit(2)', 0, logs).done
    expect(r.ok).toBe(true)
    expect(r.valueKind).toBe('documents')
    expect((r.value as { name: string }[]).map((d) => d.name)).toEqual(['a', 'b'])
    expect((r.value as { _id: ObjectId }[])[0]._id).toBeInstanceOf(ObjectId)
    expect(logs.map((l) => l.text)).toEqual(['from worker'])
    expect(r.logs).toEqual(logs)
    const n = await runWorker('Item.countDocuments()').done
    expect(n.value).toBe(3)
  })

  it('finishes a statement nobody awaited before closing the connection', async () => {
    const logs: PlaygroundLog[] = []
    const r = await runWorker(['db.getCollectionNames()', '', "console.log('test')"].join('\n'), 0, logs).done
    expect(r.ok).toBe(true)
    expect(logs.map((l) => `${l.level} ${l.text}`)).toEqual(['log test'])
  })

  it('terminates an infinite loop on timeout', async () => {
    const t = Date.now()
    const r = await runWorker('while (true) {}', 800).done
    expect(r).toMatchObject({ ok: false, cancelled: true })
    expect(r.error).toMatch(/Timed out after 800 ms/)
    expect(Date.now() - t).toBeLessThan(5000)
  })

  it('cancels a running script', async () => {
    const { pg, runId, done } = runWorker('await new Promise(() => {})')
    setTimeout(() => pg.cancel(runId), 300)
    expect(await done).toMatchObject({ ok: false, cancelled: true, error: 'Cancelled' })
  })

  it('kills the server operation of a cancelled run', async () => {
    await client.db(DB).collection('slow').insertMany(Array.from({ length: 200 }, (_, i) => ({ i })))
    const playgroundOps = async (): Promise<{ appName: string }[]> =>
      (await client
        .db('admin')
        .aggregate([{ $currentOp: { allUsers: true } }, { $match: { appName: /^Shardwise Playground / } }])
        .toArray()) as { appName: string }[]
    const { pg, runId, done } = runWorker("db.slow.find({ $where: 'sleep(100) || true' }).toArray()")
    let ops: { appName: string }[] = []
    for (let i = 0; i < 100 && !ops.length; i++) {
      await new Promise((r) => setTimeout(r, 50))
      ops = await playgroundOps()
    }
    expect(ops.length).toBe(1)
    const t = Date.now()
    pg.cancel(runId)
    expect(await done).toMatchObject({ ok: false, cancelled: true, error: 'Cancelled' })
    expect(Date.now() - t).toBeLessThan(3000)
    expect(await playgroundOps()).toEqual([])
  })

  it('reports an unknown connection', async () => {
    const pg = new Playground(mgr, () => {}, workerFile)
    const r = await pg.run({ runId: 'x', connId: 'nope', db: DB, code: '1', language: 'javascript', timeoutMS: 0 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Not connected/)
  })
})

describe('playground startup scripts', () => {
  it('runs the shell startup scripts first when asked to; their errors are logged', async () => {
    const logs: PlaygroundLog[] = []
    const r = await execute({
      client,
      db: DB,
      code: 'twice(base)',
      language: 'typescript',
      onLog: (l) => logs.push(l),
      startup: [
        { label: 'Settings', code: 'const base = 21\nfunction twice(x) { return x * 2 }' },
        { label: 'connection "Local"', code: 'nope()' }
      ],
      startupErrors: ['Could not read the startup script /x.js: ENOENT']
    })
    expect(r).toMatchObject({ ok: true, value: 42 })
    expect(logs.map((l) => [l.level, l.text.split('\n')[0]])).toEqual([
      ['warn', 'Could not read the startup script /x.js: ENOENT'],
      ['error', 'Startup script (connection "Local") failed: ReferenceError: nope is not defined (line 1)']
    ])
  })

  it('passes the startup plan to the worker', async () => {
    const pg = new Playground(mgr, () => {}, workerFile, async () => ({ scripts: [{ label: 'Settings', code: 'const fromStartup = "yes"' }], errors: [] }))
    const r = await pg.run({ runId: 's1', connId, db: DB, code: 'fromStartup', language: 'javascript', timeoutMS: 0 })
    expect(r).toMatchObject({ ok: true, value: 'yes' })
    const off = new Playground(mgr, () => {}, workerFile, async () => null)
    expect((await off.run({ runId: 's2', connId, db: DB, code: 'typeof fromStartup', language: 'javascript', timeoutMS: 0 })).value).toBe('undefined')
  })
})
