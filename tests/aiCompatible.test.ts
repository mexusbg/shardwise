import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import type { AiStreamEvent } from '@shared/aiApi'
import { AiService } from '../src/main/ai'
import { compatSecret, parseJsonAnswer } from '../src/main/ai/compatible'

// ---------------------------------------------------------------------------
// A fake OpenAI-compatible service (Chat Completions + models), so the real OpenAI SDK is exercised: HTTP,
// SSE streaming, tool-call deltas and errors. Responses are scripted per test.
// ---------------------------------------------------------------------------

type Reply =
  | { text: string; finish?: string }
  | { tool: { id: string; name: string; args: string } }
  | { status: number; message: string }

let http: Server
let base = ''
let script: Reply[] = []
let requests: Record<string, unknown>[] = []
const GOOD_KEY = 'sk-test-good'

const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } }

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function chunk(res: ServerResponse, choices: unknown[], extra: Record<string, unknown> = {}): void {
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices, ...extra })}\n\n`)
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } })
  if (req.method === 'GET' && req.url === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: 'model-b', object: 'model' }, { id: 'model-a', object: 'model' }] })
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(res, 404, { error: { message: 'not found' } })
  const params = JSON.parse(body) as Record<string, unknown>
  requests.push(params)
  const r = script.shift()
  if (!r) return send(res, 500, { error: { message: 'script exhausted' } })
  if ('status' in r) return send(res, r.status, { error: { message: r.message, type: 'invalid_request_error' } })
  if (!params.stream) {
    const message = 'text' in r ? { role: 'assistant', content: r.text, refusal: null } : { role: 'assistant', content: null, tool_calls: [{ id: r.tool.id, type: 'function', function: { name: r.tool.name, arguments: r.tool.args } }] }
    return send(res, 200, { id: 'c1', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message, finish_reason: 'text' in r ? (r.finish ?? 'stop') : 'tool_calls' }], usage })
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if ('text' in r) {
    // Text in pieces, as services stream it (the role comes with the first one).
    ;(r.text.match(/.{1,6}/gs) ?? []).forEach((piece, i) => chunk(res, [{ index: 0, delta: { ...(i ? {} : { role: 'assistant' }), content: piece }, finish_reason: null }]))
    chunk(res, [{ index: 0, delta: {}, finish_reason: r.finish ?? 'stop' }])
  } else {
    // Tool call: id and name first, the arguments in two pieces.
    const half = Math.floor(r.tool.args.length / 2)
    chunk(res, [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: r.tool.id, type: 'function', function: { name: r.tool.name, arguments: '' } }] }, finish_reason: null }])
    chunk(res, [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: r.tool.args.slice(0, half) } }] }, finish_reason: null }])
    chunk(res, [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: r.tool.args.slice(half) } }] }, finish_reason: null }])
    chunk(res, [{ index: 0, delta: {}, finish_reason: 'tool_calls' }])
  }
  if ((params.stream_options as { include_usage?: boolean } | undefined)?.include_usage) chunk(res, [], { usage })
  res.write('data: [DONE]\n\n')
  res.end()
}

let server: MongoMemoryServer
let mongo: MongoClient
let dir: string
const secrets = new Map<string, string>()
const events: AiStreamEvent[] = []
let ai: AiService

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handle(req, res, body))
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`
  server = await MongoMemoryServer.create()
  mongo = await MongoClient.connect(server.getUri())
  await mongo.db('shop').collection('orders').insertMany(Array.from({ length: 30 }, (_, i) => ({ n: i, status: i % 3 === 0 ? 'paid' : 'open' })))
  dir = mkdtempSync(join(tmpdir(), 'mg-ai-compat-'))
})

afterAll(async () => {
  http?.close()
  await mongo?.close()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  script = []
  requests = []
  events.length = 0
  secrets.clear()
  ai = new AiService({
    secrets: { getSecret: async (n) => secrets.get(n), setSecret: async (n, v) => void (v ? secrets.set(n, v) : secrets.delete(n)) },
    mongo: () => mongo,
    settingsFile: join(dir, `ai-${Math.random()}.json`),
    emit: (e) => events.push(e)
  })
  await ai.core.deps.settings.save({ provider: 'openai', compatBaseUrl: base, compatModel: 'model-a' })
  await ai.setKey(GOOD_KEY)
})

describe('OpenAI-compatible provider', () => {
  it('keeps the key per service and reports status (local servers need none)', async () => {
    expect(secrets.get(compatSecret(base))).toBe(GOOD_KEY)
    expect(await ai.core.status()).toMatchObject({ configured: true, source: 'settings', provider: 'openai', label: base.split('/')[2] })
    await ai.setKey(null)
    // 127.0.0.1 is this computer: no key needed.
    expect(await ai.core.status()).toMatchObject({ configured: true, source: 'local' })
    await ai.core.deps.settings.save({ compatBaseUrl: 'https://api.example.com/v1' })
    expect(await ai.core.status()).toMatchObject({ configured: false, source: 'none', label: 'api.example.com' })
    await ai.core.deps.settings.save({ compatBaseUrl: base, compatModel: '' })
    expect(await ai.core.status()).toMatchObject({ missingModel: true, configured: false })
  })

  it('lists the models of the service and tests the key', async () => {
    expect(await ai.core.listModels()).toEqual({ models: ['model-a', 'model-b'] })
    script = [{ text: 'OK' }]
    expect(await ai.core.test()).toMatchObject({ ok: true, model: 'fake-model' })
    const bad = await ai.core.test('sk-wrong')
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/API key was rejected by 127\.0\.0\.1/)
  })

  it('answers one-shot requests, with structured JSON and a fallback when the service lacks it', async () => {
    script = [{ text: 'Use an index on status.' }]
    expect(await ai.core.complete({ system: 'sys', user: 'why slow?' })).toBe('Use an index on status.')
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'why slow?' }
    ])

    const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    script = [{ text: '{"query":"{ status: \'paid\' }"}' }]
    expect(await ai.core.json({ system: 's', user: 'u', schema })).toEqual({ query: "{ status: 'paid' }" })
    expect(requests[1].response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'answer', schema } })

    // No structured output: asked again without response_format, schema in the prompt, fenced JSON accepted.
    script = [{ status: 400, message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported" }, { text: '```json\n{"query":"{}"}\n```' }]
    expect(await ai.core.json({ system: 's', user: 'u', schema })).toEqual({ query: '{}' })
    expect(requests[3].response_format).toBeUndefined()
    expect(String((requests[3].messages as { content: string }[])[0].content)).toContain('JSON schema')
    expect(ai.core.usage.requests).toBeGreaterThanOrEqual(3)
  })

  it('stops on a cut-off answer', async () => {
    script = [{ text: 'partial', finish: 'length' }]
    await expect(ai.core.complete({ system: 's', user: 'u' })).rejects.toThrow(/cut off/)
  })

  it('runs the assistant tool loop with streamed text and read-only tools', async () => {
    script = [{ tool: { id: 'call_1', name: 'count', args: JSON.stringify({ db: 'shop', collection: 'orders', filter: "{ status: 'paid' }" }) } }, { text: 'There are 10 paid orders.' }]
    const r = await ai.assistant.send({ chatId: 'c', target: { connId: 'x', db: 'shop', coll: 'orders' }, text: 'How many paid orders?' })
    expect(r).toEqual({ stopReason: 'end_turn' })
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('There are 10 paid orders.')
    expect(events.find((e) => e.kind === 'tool')).toMatchObject({ name: 'count', input: { filter: "{ status: 'paid' }" } })
    expect(events.find((e) => e.kind === 'toolResult')).toMatchObject({ ok: true, preview: '10' })
    // First request: system prompt, context + question, function tools, usage in the stream.
    const first = requests[0] as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[]; stream_options: unknown }
    expect(first.messages[0].role).toBe('system')
    expect(first.messages[1].content).toContain('<context>')
    expect(first.tools.map((t) => t.function.name)).toContain('count')
    expect(first.stream_options).toEqual({ include_usage: true })
    // Second request carries the assistant tool call and the tool result.
    const second = requests[1] as { messages: Record<string, unknown>[] }
    expect(second.messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'count', arguments: JSON.stringify({ db: 'shop', collection: 'orders', filter: "{ status: 'paid' }" }) } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '10' }
    ])
    expect(events.filter((e) => e.kind === 'usage')).toHaveLength(2)
  })

  it('sends no tools when read-only queries are off and starts over after a provider switch', async () => {
    await ai.core.deps.settings.save({ allowQueries: false })
    script = [{ text: 'first' }, { text: 'second' }]
    await ai.assistant.send({ chatId: 'c', target: { connId: 'x', db: 'shop', coll: 'orders' }, text: 'q1' })
    await ai.assistant.send({ chatId: 'c', target: { connId: 'x', db: 'shop', coll: 'orders' }, text: 'q2' })
    expect(requests[0].tools).toBeUndefined()
    expect((requests[1].messages as unknown[]).length).toBe(4) // system, q1, answer, q2
  })

  it('names the service in errors', async () => {
    script = [{ status: 404, message: 'model not found' }]
    await expect(ai.assistant.send({ chatId: 'e', target: null, text: 'hi' })).rejects.toThrow(/127\.0\.0\.1:\d+ does not know the model "model-a"/)
  })
})

describe('JSON answers', () => {
  it('reads plain, fenced and prefixed JSON', () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonAnswer('```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(parseJsonAnswer('Here you go: {"a":3}')).toEqual({ a: 3 })
  })
})
