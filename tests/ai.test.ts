import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId } from 'mongodb'
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, BetaMessageStreamParams, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { DEFAULT_AI_SETTINGS } from '@shared/aiApi'
import type { AiStreamEvent } from '@shared/aiApi'
import { extractQueryFences, parseProposedQuery } from '@shared/aiQuery'
import { AiService } from '../src/main/ai'
import { AiCore, AiStopError, friendlyError } from '../src/main/ai/client'
import type { AnthropicLike, StreamLike } from '../src/main/ai/client'
import { AiSettingsStore } from '../src/main/ai/settings'
import { docsText } from '../src/main/ai/context'
import { fixQuery } from '../src/main/ai/actions'
import { findWriteStage, readOnlyPipeline, runTool } from '../src/main/ai/tools'

let server: MongoMemoryServer
let mongo: MongoClient
let dir: string

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  mongo = await MongoClient.connect(server.getUri())
  await mongo
    .db('shop')
    .collection('orders')
    .insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        _id: new ObjectId(),
        n: i,
        status: i % 3 === 0 ? 'paid' : 'open',
        note: 'x'.repeat(i === 0 ? 5000 : 10)
      }))
    )
  dir = mkdtempSync(join(tmpdir(), 'mg-ai-'))
})

afterAll(async () => {
  await mongo?.close()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fake Anthropic client: scripted responses, recorded requests (no network)
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }
const message = (content: Block[], stop_reason: string, extra: Record<string, unknown> = {}): BetaMessage =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_details: null, usage, ...extra }) as unknown as BetaMessage
const text = (t: string): Block => ({ type: 'text', text: t, citations: null })
const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input })

class FakeAnthropic implements AnthropicLike {
  requests: (MessageCreateParamsNonStreaming | BetaMessageStreamParams)[] = []
  constructor(private script: (BetaMessage | Error)[]) {}
  private next(params: MessageCreateParamsNonStreaming | BetaMessageStreamParams): BetaMessage {
    // Snapshot: the assistant keeps mutating its history array.
    this.requests.push(JSON.parse(JSON.stringify(params)))
    const r = this.script.shift()
    if (!r) throw new Error('script exhausted')
    if (r instanceof Error) throw r
    return r
  }
  beta = {
    messages: {
      create: async (params: MessageCreateParamsNonStreaming): Promise<BetaMessage> => this.next(params),
      stream: (params: BetaMessageStreamParams): StreamLike => {
        let listener: ((d: string, s: string) => void) | null = null
        let msg: BetaMessage | null = null
        let error: unknown = null
        try {
          msg = this.next(params)
        } catch (e) {
          error = e
        }
        return {
          on: (_e, l) => (listener = l),
          finalMessage: async () => {
            await Promise.resolve()
            if (error) throw error
            for (const b of msg!.content) if (b.type === 'text') for (const part of b.text.match(/.{1,5}/gs) ?? []) listener?.(part, '')
            return msg!
          },
          abort: () => {}
        }
      }
    }
  }
}

function setup(script: (BetaMessage | Error)[], settings: Record<string, unknown> = {}): { ai: AiService; fake: FakeAnthropic; events: AiStreamEvent[] } {
  const fake = new FakeAnthropic(script)
  const events: AiStreamEvent[] = []
  const file = join(dir, `s-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify(settings))
  const ai = new AiService({
    secrets: { getSecret: async () => 'sk-test', setSecret: async () => {} },
    mongo: () => mongo,
    settingsFile: file,
    emit: (e) => events.push(e),
    createClient: () => fake
  })
  return { ai, fake, events }
}

const target = { connId: 'c1', db: 'shop', coll: 'orders' }

describe('assistant tool loop', () => {
  it('runs tool calls, returns all results in one user message and streams text', async () => {
    const { ai, fake, events } = setup([
      message([text('Let me check.'), toolUse('t1', 'count', { db: 'shop', collection: 'orders', filter: "{ status: 'paid' }" }), toolUse('t2', 'find', { db: '', collection: '', filter: '{ n: { $lt: 3 } }', projection: '{ n: 1, _id: 0 }', sort: '{ n: 1 }', limit: 50 })], 'tool_use'),
      message([text("There are 10 paid orders.\n```mongo-find orders\n{ filter: { status: 'paid' } }\n```")], 'end_turn')
    ])
    const r = await ai.assistant.send({ chatId: 'a', target, text: 'How many paid orders?' })
    expect(r.stopReason).toBe('end_turn')

    const [first, second] = fake.requests as BetaMessageStreamParams[]
    expect(first.model).toBe('claude-opus-5-5')
    expect(first.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(first.fallbacks).toBe('default')
    expect(first.max_tokens).toBe(32000)
    expect(first.output_config).toEqual({ effort: 'medium' })
    expect(first.tool_choice).toEqual({ type: 'auto' })
    expect('thinking' in first).toBe(false)
    expect((first.system as unknown as Block[]).at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
    expect(first.tools!.every((t) => (t as { strict?: boolean }).strict === true)).toBe(true)
    expect(first.tools!.every((t) => (t as unknown as { input_schema: { additionalProperties: boolean } }).input_schema.additionalProperties === false)).toBe(true)
    const ctx = (first.messages[0].content as unknown as Block[])[0].text as string
    expect(ctx).toContain('Current collection: orders')
    expect(ctx).toContain('status: String')
    expect(ctx.split('</context>')[0]).not.toContain('paid') // types only, no values

    // Full assistant content (text + tool_use) appended, then one user message with both results.
    expect(second.messages).toHaveLength(3)
    expect((second.messages[1].content as unknown as Block[]).map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use'])
    const results = second.messages[2].content as unknown as Block[]
    expect(second.messages[2].role).toBe('user')
    expect(results.map((b) => [b.type, b.tool_use_id])).toEqual([
      ['tool_result', 't1'],
      ['tool_result', 't2']
    ])
    expect(results[0].content).toBe('10')
    expect(results[0].is_error).toBeUndefined()
    expect(results[1].content).toContain('{"n":0}')
    expect(results[1].content).toContain('{"n":2}')

    const deltas = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('')
    expect(deltas).toContain('There are 10 paid orders.')
    expect(events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name)).toEqual(['count', 'find'])
    expect(events.find((e) => e.kind === 'toolResult' && e.id === 't1')).toMatchObject({ ok: true, summary: '10 documents' })
    expect(ai.core.usage).toEqual({ requests: 2, input: 200, output: 40, cacheRead: 100, cacheWrite: 20 })
    expect(ai.assistant.history('a')).toHaveLength(4)
  })

  it('reports failing tools with is_error and rejects writes', async () => {
    const { ai, fake } = setup([
      message(
        [
          toolUse('w', 'aggregate', { db: 'shop', collection: 'orders', pipeline: "[ { $match: {} }, { $out: 'copy' } ]" }),
          toolUse('s', 'find', { db: 'shop', collection: 'orders', filter: '{ n: ', projection: '', sort: '', limit: 5 })
        ],
        'tool_use'
      ),
      message([text('Sorry, I can only read.')], 'end_turn')
    ])
    await ai.assistant.send({ chatId: 'b', target, text: 'copy the collection' })
    const results = (fake.requests[1] as BetaMessageStreamParams).messages[2].content as unknown as Block[]
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ tool_use_id: 'w', is_error: true })
    expect(results[0].content).toMatch(/\$out writes data/)
    expect(results[1]).toMatchObject({ tool_use_id: 's', is_error: true })
    expect(await mongo.db('shop').listCollections({ name: 'copy' }).toArray()).toHaveLength(0)
  })

  it('caps documents per result with the maxDocs setting', async () => {
    const { ai, fake } = setup(
      [message([toolUse('f', 'find', { db: 'shop', collection: 'orders', filter: '{}', projection: '{ n: 1 }', sort: '{ n: 1 }', limit: 50 })], 'tool_use'), message([text('ok')], 'end_turn')],
      { maxDocs: 2 }
    )
    await ai.assistant.send({ chatId: 'c', target, text: 'show orders' })
    const content = ((fake.requests[1] as BetaMessageStreamParams).messages[2].content as unknown as Block[])[0].content as string
    expect(content.split('\n').filter((l) => l.startsWith('{'))).toHaveLength(2)
    expect(content).toContain('more match')
  })

  it('drops the exchange on refusal and shows the explanation', async () => {
    const { ai } = setup([message([], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: 'Not something I can help with.' } })])
    const r = await ai.assistant.send({ chatId: 'd', target, text: 'something bad' })
    expect(r).toEqual({ stopReason: 'refusal', note: 'Claude declined this request: Not something I can help with.' })
    expect(ai.assistant.history('d')).toHaveLength(0)
  })

  it('keeps text but not a cut-off tool call on max_tokens', async () => {
    const { ai } = setup([message([text('Partial answer'), toolUse('x', 'count', { db: 'shop', collection: 'orders', filter: '{}' })], 'max_tokens')])
    const r = await ai.assistant.send({ chatId: 'e', target, text: 'long' })
    expect(r.stopReason).toBe('max_tokens')
    const h = ai.assistant.history('e')
    expect((h[1].content as unknown as Block[]).map((b) => b.type)).toEqual(['text'])
  })

  it('continues after pause_turn and stops after the step cap', async () => {
    const paused = setup([message([text('Working')], 'pause_turn'), message([text('Done')], 'end_turn')])
    expect((await paused.ai.assistant.send({ chatId: 'f', target, text: 'go' })).stopReason).toBe('end_turn')
    expect(paused.fake.requests).toHaveLength(2)
    expect((paused.fake.requests[1] as BetaMessageStreamParams).messages.at(-1)!.role).toBe('assistant')

    const loop = Array.from({ length: 13 }, (_, i) => message([toolUse(`c${i}`, 'count', { db: 'shop', collection: 'orders', filter: '{}' })], 'tool_use'))
    const capped = setup(loop)
    const r = await capped.ai.assistant.send({ chatId: 'g', target, text: 'loop' })
    expect(r.stopReason).toBe('max_steps')
    expect(capped.fake.requests).toHaveLength(12)
    // The next message merges into the trailing tool_result turn instead of breaking alternation.
    const h = capped.ai.assistant.history('g')
    expect(h.at(-1)!.role).toBe('user')
  })

  it('sends no tools when read-only queries are disabled, and honours model / effort', async () => {
    const { ai, fake } = setup([message([text('Hi')], 'end_turn')], { allowQueries: false, model: 'claude-haiku-5-5', effort: 'low' })
    await ai.assistant.send({ chatId: 'h', target, text: 'hello' })
    const p = fake.requests[0] as BetaMessageStreamParams
    expect(p.tools).toBeUndefined()
    expect(p.model).toBe('claude-haiku-5-5')
    expect(p.output_config).toEqual({ effort: 'low' })
    expect(((p.messages[0].content as unknown as Block[])[0].text as string)).toContain('disabled by the user')
  })

  it('maps SDK errors to friendly messages', async () => {
    const { ai } = setup([new Anthropic.APIConnectionError({ message: 'offline' })])
    await expect(ai.assistant.send({ chatId: 'i', target, text: 'x' })).rejects.toThrow('Could not reach the Anthropic API')
    expect(friendlyError(new Error('Could not resolve authentication method. Expected one of apiKey')).message).toMatch(/No Anthropic API key/)
  })
})

describe('one-shot requests', () => {
  it('throws on refusal and max_tokens, parses JSON answers', async () => {
    const { ai, fake } = setup([
      message([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Nope.' } }),
      message([text('cut')], 'max_tokens'),
      message([text('{"query":"{ n: 1 }","projection":"","sort":"","limit":"","explanation":"Fixed the brace."}')], 'end_turn')
    ])
    await expect(ai.core.complete({ system: 's', user: 'u' })).rejects.toThrow(AiStopError)
    await expect(ai.core.complete({ system: 's', user: 'u' })).rejects.toThrow(/cut off/)
    const r = await fixQuery(ai.core, mongo, {
      connId: 'c1',
      db: 'shop',
      coll: 'orders',
      query: { query: '{ n: 1', projection: '', sort: '', skip: '', limit: '' },
      error: { part: 'query', message: 'Unexpected token' }
    })
    expect(r.query).toBe('{ n: 1 }')
    const p = fake.requests[2] as MessageCreateParamsNonStreaming
    expect(p.max_tokens).toBe(16000)
    expect(p.fallbacks).toBe('default')
    expect(p.output_config?.format?.type).toBe('json_schema')
  })
})

describe('tools', () => {
  it('rejects $out / $merge anywhere in a pipeline', () => {
    expect(() => readOnlyPipeline("[{ $out: 'x' }]")).toThrow(/\$out/)
    expect(() => readOnlyPipeline("[{ $facet: { a: [ { $merge: { into: 'x' } } ] } }]")).toThrow(/\$merge/)
    expect(findWriteStage([{ $lookup: { from: 'x', pipeline: [{ $match: {} }] } }])).toBeNull()
    expect(readOnlyPipeline("[{ $match: { status: 'paid' } }]")).toHaveLength(1)
  })

  it('truncates large results by size and clips long values', async () => {
    const r = await runTool('find', { db: 'shop', collection: 'orders', filter: '{ n: 0 }', projection: '', sort: '', limit: 1 }, { client: () => mongo, maxDocs: 20 })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('(5000 chars)')
    const big = Array.from({ length: 50 }, (_, i) => ({ i, s: 'y'.repeat(390) }))
    const t = docsText(big, 50, 2000)
    expect(t.truncated).toBe(true)
    expect(t.text.length).toBeLessThanOrEqual(2000)
  })

  it('runs schema, aggregate and explain tools', async () => {
    const env = { client: () => mongo, db: 'shop', coll: 'orders', maxDocs: 5 }
    const schema = await runTool('collection_schema', { db: '', collection: '' }, env)
    expect(schema.content).toContain('status: String')
    const agg = await runTool('aggregate', { db: 'shop', collection: 'orders', pipeline: "[ { $group: { _id: '$status', c: { $sum: 1 } } }, { $sort: { _id: 1 } } ]" }, env)
    expect(agg.content).toContain('"_id":"open","c":20')
    const ex = await runTool('explain', { db: 'shop', collection: 'orders', filter: "{ status: 'paid' }", sort: '', projection: '', pipeline: '' }, env)
    expect(ex.ok).toBe(true)
    expect(ex.content).toContain('COLLSCAN')
  })
})

describe('settings', () => {
  it('persists non-secret settings and normalises bad values', async () => {
    const file = join(dir, 'ai-settings.json')
    const a = new AiSettingsStore(file)
    expect(await a.get()).toEqual(DEFAULT_AI_SETTINGS)
    await a.save({ model: 'claude-sonnet-5-5', effort: 'high', sendSamples: true, maxDocs: 500 })
    const b = new AiSettingsStore(file)
    expect(await b.get()).toEqual({ ...DEFAULT_AI_SETTINGS, model: 'claude-sonnet-5-5', effort: 'high', sendSamples: true, maxDocs: 50 })
    writeFileSync(file, JSON.stringify({ model: 'gpt-x', effort: 'max', maxDocs: -3 }))
    expect(await new AiSettingsStore(file).get()).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', maxDocs: 20 })
    expect(readFileSync(file, 'utf8')).not.toContain('sk-')
    // OpenAI-compatible provider: address without trailing slash, bad values back to the defaults.
    const c = new AiSettingsStore(file)
    expect(await c.save({ provider: 'openai', compatBaseUrl: ' http://localhost:11434/v1/ ', compatModel: ' llama3.2 ' })).toMatchObject({ provider: 'openai', compatBaseUrl: 'http://localhost:11434/v1', compatModel: 'llama3.2' })
    writeFileSync(file, JSON.stringify({ provider: 'gemini', compatBaseUrl: 'not a url' }))
    expect(await new AiSettingsStore(file).get()).toMatchObject({ provider: 'anthropic', compatBaseUrl: DEFAULT_AI_SETTINGS.compatBaseUrl })
  })

  it('counts session usage and tests the key with a tiny request', async () => {
    const { ai, fake } = setup([message([text('OK')], 'end_turn')])
    const r = await ai.core.test('sk-new')
    expect(r.ok).toBe(true)
    expect((fake.requests[0] as MessageCreateParamsNonStreaming).output_config).toEqual({ effort: 'low' })
    expect(ai.core.usage.requests).toBe(1)
    expect(ai.core.resetUsage().input).toBe(0)
  })

  it('a fresh core uses the injected settings', () => {
    const core = new AiCore({ secrets: { getSecret: async () => undefined }, settings: new AiSettingsStore(join(dir, 'none.json')) })
    expect(core.base({ ...DEFAULT_AI_SETTINGS, model: 'claude-sonnet-5-5', effort: 'low' })).toEqual({
      model: 'claude-sonnet-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    })
  })
})

describe('proposed query fences', () => {
  const md = "Try this:\n```mongo-find orders\n{ filter: { status: 'paid', _id: ObjectId('650000000000000000000001') }, sort: { n: -1 }, limit: 5 }\n```\nOr:\n```mongo-aggregate\n[ { $match: { n: { $gt: 3 } } }, { $count: 'n' } ]\n```\n```javascript\ndb.x.drop()\n```"

  it('extracts mongo-find / mongo-aggregate blocks only', () => {
    const f = extractQueryFences(md)
    expect(f.map((x) => [x.lang, x.coll])).toEqual([
      ['mongo-find', 'orders'],
      ['mongo-aggregate', undefined]
    ])
  })

  it('parses find and aggregate bodies', () => {
    const [find, agg] = extractQueryFences(md)
    const q = parseProposedQuery(find.lang, find.body, find.coll)
    expect(q.kind).toBe('find')
    if (q.kind !== 'find') return
    expect(q.coll).toBe('orders')
    expect(q.filter.status).toBe('paid')
    expect((q.filter._id as ObjectId).toHexString()).toBe('650000000000000000000001')
    expect(q.sort).toEqual({ n: -1 })
    expect(q.projection).toBeNull()
    expect(q.limit).toBe(5)

    const a = parseProposedQuery(agg.lang, agg.body, 'orders')
    expect(a.kind).toBe('aggregate')
    if (a.kind === 'aggregate') expect(a.pipeline.map((s) => Object.keys(s)[0])).toEqual(['$match', '$count'])

    const bare = parseProposedQuery('mongo-find', "{ status: 'open' }")
    expect(bare).toMatchObject({ kind: 'find', filter: { status: 'open' }, limit: 0 })
    expect(() => parseProposedQuery('mongo-aggregate', '{ $match: {} }')).toThrow(/array/)
    expect(() => parseProposedQuery('mongo-find', '{ filter: ')).toThrow()
  })
})
