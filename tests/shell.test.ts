import { resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { build } from 'rolldown'
import { parseUri } from '@shared/connection'
import { isIncomplete, parseCommand } from '@shared/shell'
import type { PlaygroundLog } from '@shared/api'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Repl } from '../src/main/playground/repl'
import { ShellSessions } from '../src/main/playground/shellSessions'
import { prepare } from '../src/main/playground/transpile'
import { loadStartupScripts } from '../src/main/playground/startup'
import type { ShellConfirmRequest } from '@shared/shellOptions'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let connId: string
const workerFile = resolve(__dirname, '../node_modules/.cache/shardwise-shell-test/playgroundWorker.js')
const DB = 'shop'

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client
    .db(DB)
    .collection('items')
    .insertMany(Array.from({ length: 45 }, (_, i) => ({ n: i })))
  await client.db(DB).collection('notes').insertOne({ text: 'hi' })
  await client.db('other').collection('people').insertOne({ name: 'zed' })
  mgr = new ConnectionManager()
  connId = (await mgr.connect(parseUri(server.getUri()))).connId
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

describe('shell input helpers', () => {
  it('parses statement commands', () => {
    expect(parseCommand('use other')).toEqual({ kind: 'use', db: 'other' })
    expect(parseCommand('use other;')).toEqual({ kind: 'use', db: 'other' })
    expect(parseCommand("use('other')")).toBeNull()
    expect(parseCommand('use = 5')).toBeNull()
    expect(parseCommand(' show  dbs ')).toEqual({ kind: 'show', what: 'dbs', arg: undefined })
    expect(parseCommand('it')).toEqual({ kind: 'it' })
    expect(parseCommand('cls')).toEqual({ kind: 'cls' })
    expect(parseCommand('items')).toBeNull()
  })

  it('detects unfinished input', () => {
    expect(isIncomplete('db.items.find({')).toBe(true)
    expect(isIncomplete('function f() {\n  return 1')).toBe(true)
    expect(isIncomplete('const s = `a')).toBe(true)
    expect(isIncomplete('db.items.find({ a: "}" })')).toBe(false)
    expect(isIncomplete('// {')).toBe(false)
    expect(isIncomplete('[1, 2]')).toBe(false)
  })

  it('hoists top-level declarations without moving lines', async () => {
    const p = await prepare('let a = 1, b\nlet { c } = { c: 2 }\nfunction f() {}\nclass K {}\na', 'javascript', { hoist: true })
    expect(p.js.split('\n')).toHaveLength(5)
    expect(p.js).toContain(';(  a = 1, b = undefined)')
    expect(p.js).toContain(';(  { c } = { c: 2 })')
    expect(p.js).toContain('globalThis.f = f')
    expect(p.js).toContain('globalThis.K = K')
  })
})

describe('shell repl', () => {
  const newRepl = (logs: PlaygroundLog[] = []): Repl => new Repl(client, DB, (l) => logs.push(l))

  it('keeps variables, functions and classes between evaluations', async () => {
    const r = newRepl()
    expect((await r.evaluate('const a = 1')).valueKind).toBe('undefined')
    expect(await r.evaluate('a + 1')).toMatchObject({ ok: true, value: 2 })
    await r.evaluate('function twice(x) { return x * 2 }')
    expect((await r.evaluate('twice(a + 20)')).value).toBe(42)
    await r.evaluate('let counter = 0\nfunction inc() { return ++counter }')
    await r.evaluate('inc(); inc()')
    expect((await r.evaluate('counter')).value).toBe(2)
    await r.evaluate('class Box { constructor(v) { this.v = v } }')
    expect((await r.evaluate('new Box(3).v')).value).toBe(3)
    await r.evaluate('const { x, y: [z] } = { x: 5, y: [6] }')
    expect((await r.evaluate('x + z')).value).toBe(11)
    await r.evaluate('const docs = await db.notes.find({}, { _id: 0 }).toArray()')
    expect((await r.evaluate('docs')).value).toEqual([{ text: 'hi' }])
    expect((await r.evaluate('const a = 10\na')).value).toBe(10)
  })

  it('streams console output', async () => {
    const logs: PlaygroundLog[] = []
    const r = newRepl(logs)
    await r.evaluate('print("hello"); console.warn({ a: 1 })')
    expect(logs.map((l) => [l.level, l.text.replace(/\s+/g, ' ')])).toEqual([
      ['log', 'hello'],
      ['warn', '{ a: 1 }']
    ])
  })

  it('maps errors to the input', async () => {
    const r = newRepl()
    const e = await r.evaluate('const q = 1\nnope()')
    expect(e).toMatchObject({ ok: false, error: 'ReferenceError: nope is not defined (line 2)' })
    expect(e.stack).toContain('> 2 | nope()')
    expect((await r.evaluate('q')).value).toBe(1)
    expect((await r.evaluate('a +')).error).toMatch(/^SyntaxError/)
  })

  it('switches databases with use', async () => {
    const r = newRepl()
    expect(await r.evaluate('use other')).toMatchObject({ ok: true, value: 'switched to db other', db: 'other' })
    expect((await r.evaluate('db.people.findOne({}, { _id: 0 })')).value).toEqual({ name: 'zed' })
    expect((await r.evaluate('db.getName()')).value).toBe('other')
    expect((await r.evaluate(`use('${DB}')`)).db).toBe(DB)
  })

  it('shows databases, collections and an empty profile', async () => {
    const r = newRepl()
    expect((await r.evaluate('show collections')).value).toBe('items\nnotes')
    const dbs = (await r.evaluate('show dbs')).value as string
    expect(dbs).toMatch(/^other\s+\d+\.\d{2} KiB$/m)
    expect(dbs).toMatch(/^shop\s+/m)
    expect((await r.evaluate('show users')).value).toEqual([])
    expect((await r.evaluate('show profile')).value).toMatch(/system\.profile is empty/)
    expect((await r.evaluate('show nonsense')).ok).toBe(false)
    expect((await r.evaluate('help')).value).toMatch(/show collections/)
  })

  it('pages cursors with it', async () => {
    const r = newRepl()
    expect((await r.evaluate('it')).value).toBe('no cursor')
    const first = await r.evaluate('db.items.find({}, { _id: 0 }).sort({ n: 1 })')
    expect(first).toMatchObject({ ok: true, valueKind: 'documents', more: true })
    expect((first.value as { n: number }[]).map((d) => Number(d.n))).toEqual(Array.from({ length: 20 }, (_, i) => i))
    const second = await r.evaluate('it')
    expect(Number((second.value as { n: number }[])[0].n)).toBe(20)
    expect(second.more).toBe(true)
    const third = await r.evaluate('it')
    expect((third.value as unknown[]).length).toBe(5)
    expect(third.more).toBeUndefined()
    expect((await r.evaluate('it')).value).toBe('no cursor')
    // A whole array is not paged.
    const all = await r.evaluate('db.items.find().toArray()')
    expect((all.value as unknown[]).length).toBe(45)
    expect(all.more).toBeUndefined()
    await r.close()
  })
})

describe('shell sessions (worker)', () => {
  it('persists state, interrupts a loop, restarts with variables reset and closes', async () => {
    const logs: string[] = []
    const shells = new ShellSessions(mgr, (_id, l) => logs.push(l.text), workerFile)
    const id = await shells.open(connId, DB)
    expect(shells.hasWorker(id)).toBe(true)
    expect((await shells.evaluate(id, 'const a = 1')).ok).toBe(true)
    expect(await shells.evaluate(id, 'a + 1')).toMatchObject({ ok: true, value: 2, runId: id })
    expect((await shells.evaluate(id, 'use other')).db).toBe('other')
    const r = await shells.evaluate(id, 'print("x"); 5')
    expect(r.logs.map((l) => l.text)).toEqual(['x'])
    expect(logs).toContain('x')

    const loop = shells.evaluate(id, 'while (true) {}')
    await new Promise((r) => setTimeout(r, 300))
    await shells.interrupt(id)
    const stopped = await loop
    expect(stopped).toMatchObject({ ok: false, cancelled: true, reset: true })
    expect(stopped.error).toMatch(/variables were reset/)

    const after = await shells.evaluate(id, 'typeof a')
    expect(after).toMatchObject({ ok: true, value: 'undefined', db: 'other' })
    expect((await shells.evaluate(id, '6 * 7')).value).toBe(42)

    const timedOut = await shells.evaluate(id, 'while (true) {}', 300)
    expect(timedOut).toMatchObject({ cancelled: true, reset: true })
    expect(timedOut.error).toMatch(/^Timed out after 300 ms/)
    expect((await shells.evaluate(id, '1 + 1')).value).toBe(2)

    await shells.close(id)
    expect(shells.hasWorker(id)).toBe(false)
    expect(shells.size).toBe(0)
    await expect(shells.evaluate(id, '1')).rejects.toThrow(/closed/)
  })

  it('fails to open on a closed connection', async () => {
    const shells = new ShellSessions(mgr, () => {}, workerFile)
    await expect(shells.open('nope', DB)).rejects.toThrow()
    expect(shells.size).toBe(0)
  })
})

describe('shell startup scripts', () => {
  const plan = (scripts: { label: string; code: string }[], errors: string[] = [], timeoutMS = 0) => async () => ({ scripts, errors, timeoutMS })

  it('loads the Settings script (typed or from a file) and the connection script', async () => {
    const files: Record<string, string> = { '/rc.js': 'const fromFile = 1' }
    const read = async (p: string): Promise<string> => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    }
    const inline = await loadStartupScripts({ shellStartupSource: 'inline', shellStartupScript: 'const a = 1', shellStartupFile: '/rc.js' }, { name: 'Local', shellStartupScript: 'const b = 2' }, read)
    expect(inline).toEqual({ scripts: [{ label: 'Settings', code: 'const a = 1' }, { label: 'connection "Local"', code: 'const b = 2' }], errors: [] })
    const file = await loadStartupScripts({ shellStartupSource: 'file', shellStartupScript: 'ignored', shellStartupFile: '/rc.js' }, undefined, read)
    expect(file.scripts).toEqual([{ label: 'rc.js', code: 'const fromFile = 1' }])
    const missing = await loadStartupScripts({ shellStartupSource: 'file', shellStartupScript: '', shellStartupFile: '/nope.js' }, { name: 'L', shellStartupScript: '  ' }, read)
    expect(missing.scripts).toEqual([])
    expect(missing.errors[0]).toMatch(/Could not read the startup script \/nope\.js: ENOENT/)
  })

  it('runs them when a session starts and restarts; errors do not stop the session', async () => {
    const shells = new ShellSessions(mgr, () => {}, workerFile, {
      startup: plan(
        [
          { label: 'Settings', code: 'const greet = (n) => "hi " + n\nprint("loaded")\nlet counter = 41' },
          { label: 'connection "x"', code: 'counter++\nundefinedFn()' }
        ],
        ['Could not read the startup script /x.js: ENOENT']
      )
    })
    const id = await shells.open(connId, DB)
    const reports = shells.takeStartup(id)!
    expect(reports.map((r) => [r.label, r.ok])).toEqual([
      ['startup script', false],
      ['Settings', true],
      ['connection "x"', false]
    ])
    expect(reports[1].logs.map((l) => l.text)).toEqual(['loaded'])
    expect(reports[2].error).toMatch(/ReferenceError: undefinedFn is not defined \(line 2\)/)
    expect(shells.takeStartup(id)).toBeUndefined()
    // Variables defined by the startup scripts are there; the session works.
    expect((await shells.evaluate(id, 'greet("db")')).value).toBe('hi db')
    expect((await shells.evaluate(id, 'counter')).value).toBe(42)
    // A restart (interrupt) runs them again and reports them with that command.
    const loop = shells.evaluate(id, 'counter = 0; while (true) {}')
    await new Promise((r) => setTimeout(r, 300))
    await shells.interrupt(id)
    const stopped = await loop
    expect(stopped.reset).toBe(true)
    expect(stopped.startup?.map((r) => r.label)).toEqual(['startup script', 'Settings', 'connection "x"'])
    expect((await shells.evaluate(id, 'counter')).value).toBe(42)
    await shells.close(id)
  })

  it('stops a startup script that runs too long and starts without it', async () => {
    const shells = new ShellSessions(mgr, () => {}, workerFile, { startup: plan([{ label: 'Settings', code: 'globalThis.x = 1\nwhile (true) {}' }], [], 500) })
    const id = await shells.open(connId, DB)
    const [r] = shells.takeStartup(id)!
    expect(r).toMatchObject({ label: 'Settings', ok: false })
    expect(r.error).toMatch(/did not finish within 500 ms/)
    expect((await shells.evaluate(id, 'typeof x')).value).toBe('undefined')
    await shells.close(id)
  })
})

describe('shell confirmations', () => {
  it('asks before destructive commands and runs or skips them on the answer', async () => {
    await client.db(DB).collection('scratch').insertMany([{ a: 1 }, { a: 2 }])
    const asked: ShellConfirmRequest[] = []
    let answer = false
    const shells: ShellSessions = new ShellSessions(mgr, () => {}, workerFile, {
      onConfirm: (req) => {
        asked.push(req)
        setTimeout(() => shells.confirmReply(req.sessionId, req.id, answer), 50)
      }
    })
    const id = await shells.open(connId, DB)
    const opts = { confirm: 'destructive' as const }

    // Denied: nothing happens and the command fails with a clear message.
    const denied = await shells.evaluate(id, 'db.scratch.deleteMany({})', 0, opts)
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/Not run: "Delete every document in shop\.scratch" was declined/)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ sessionId: id, level: 'destructive', summary: 'Delete every document in shop.scratch' })
    expect(asked[0].op).toBe("db.getSiblingDB('shop').getCollection('scratch').deleteMany({}, {})")
    expect(await client.db(DB).collection('scratch').countDocuments()).toBe(2)

    // Filtered deletes and reads do not ask in "destructive" mode.
    expect((await shells.evaluate(id, 'db.scratch.deleteOne({ a: 1 })', 0, opts)).ok).toBe(true)
    expect(asked).toHaveLength(1)

    // Approved: it runs. The time limit (30 ms) is paused while waiting for the answer (50 ms).
    answer = true
    const dropped = await shells.evaluate(id, 'db.scratch.drop()', 30, opts)
    expect(dropped).toMatchObject({ ok: true, value: true })
    expect(asked[1]).toMatchObject({ level: 'destructive', summary: expect.stringMatching(/^Drop the collection shop\.scratch/) })
    expect((await client.db(DB).listCollections({ name: 'scratch' }).toArray()).length).toBe(0)

    // "Every write" asks for inserts too; "off" never asks.
    answer = false
    const insert = await shells.evaluate(id, 'db.scratch.insertOne({ a: 3 })', 0, { confirm: 'writes' })
    expect(insert.error).toMatch(/declined/)
    expect(asked[2].level).toBe('write')
    expect((await shells.evaluate(id, 'await db.scratch.insertOne({ a: 3 }); await db.scratch.drop()', 0, { confirm: 'off' })).ok).toBe(true)
    expect(asked).toHaveLength(3)
    await shells.close(id)
  })

  it('declines when nobody can answer and when the command is interrupted while waiting', async () => {
    const noUi = new ShellSessions(mgr, () => {}, workerFile)
    const id = await noUi.open(connId, DB)
    expect((await noUi.evaluate(id, 'db.items.drop()', 0, { confirm: 'destructive' })).error).toMatch(/declined/)
    expect(await client.db(DB).collection('items').countDocuments()).toBe(45)
    await noUi.close(id)

    const waiting = new ShellSessions(mgr, () => {}, workerFile, { onConfirm: () => {} })
    const id2 = await waiting.open(connId, DB)
    const pending = waiting.evaluate(id2, 'db.items.drop()', 0, { confirm: 'destructive' })
    await new Promise((r) => setTimeout(r, 300))
    await waiting.interrupt(id2)
    expect(await pending).toMatchObject({ ok: false, cancelled: true })
    expect(await client.db(DB).collection('items').countDocuments()).toBe(45)
    await waiting.close(id2)
  })

  it('uses the batch size and print options of each command', async () => {
    const logs: string[] = []
    const shells = new ShellSessions(mgr, (_id, l) => logs.push(l.text), workerFile)
    const id = await shells.open(connId, DB)
    const first = await shells.evaluate(id, 'db.items.find({}, { _id: 0 }).sort({ n: 1 })', 0, { batchSize: 7 })
    expect((first.value as unknown[]).length).toBe(7)
    expect(first.more).toBe(true)
    expect(((await shells.evaluate(id, 'it', 0, { batchSize: 40 })).value as unknown[]).length).toBe(38)
    await shells.evaluate(id, 'print({ n: NumberInt(5), deep: { a: { b: { c: 1 } } } })', 0, { print: { depth: 2, numbers: 'plain', dates: 'iso' } })
    expect(logs.pop()).toBe('{ n: 5, deep: { a: [Object] } }')
    await shells.close(id)
  })
})
