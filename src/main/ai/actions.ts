import type { MongoClient } from 'mongodb'
import { isPlainDoc, parseShellValue } from '@shared/bsonValue'
import type {
  AiCodeRequest,
  AiCodeResult,
  AiExplainQueryRequest,
  AiExplainStageRequest,
  AiFixQueryRequest,
  AiFixResult,
  AiPipelineRequest,
  AiPipelineResult,
  AiQueryTexts,
  AiText
} from '@shared/aiApi'
import type { Doc } from '@shared/api'
import * as ops from '../mongo/ops'
import type { AiCore } from './client'
import { collectionContext, explainText } from './context'
import { findWriteStage } from './tools'

const SHELL = `Write mongo shell syntax: ObjectId('…'), ISODate('…'), NumberLong(…), NumberDecimal('…'), regex literals. Use field names and stored types from the schema you are given.`
const READ_ONLY = 'Never write stages or operators that modify data ($out, $merge, updates, deletes) unless the user explicitly asks; nothing runs automatically.'
const STYLE = 'Answer in concise markdown: short paragraphs, bullet lists, inline code and fenced code blocks. No tables and no headings.'

function queryLabel(q: AiQueryTexts): string {
  return [
    `query: ${q.query.trim() || '{}'}`,
    q.projection.trim() && `projection: ${q.projection}`,
    q.sort.trim() && `sort: ${q.sort}`,
    q.skip.trim() && `skip: ${q.skip}`,
    q.limit.trim() && `limit: ${q.limit}`
  ]
    .filter(Boolean)
    .join('\n')
}

function parseDoc(text: string): Doc | null {
  if (!text.trim()) return null
  const v = parseShellValue(text)
  return isPlainDoc(v) ? v : null
}

async function indexesText(client: MongoClient, db: string, coll: string): Promise<string> {
  try {
    const list = await ops.listIndexes(client, db, coll)
    return list.map((i) => `${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' unique' : ''}${i.sparse ? ' sparse' : ''}${i.hidden ? ' hidden' : ''}${i.partialFilterExpression ? ' partial' : ''}`).join('\n') || '(none)'
  } catch {
    return '(unavailable)'
  }
}

/** Schema context that never fails the action. */
async function schemaOf(core: AiCore, client: MongoClient, db: string, coll: string): Promise<string> {
  const s = await core.settings()
  try {
    return await collectionContext(client, db, coll, s.sendSamples)
  } catch (e) {
    return `(schema unavailable: ${(e as Error).message})`
  }
}

export async function explainQuery(core: AiCore, client: MongoClient, req: AiExplainQueryRequest): Promise<AiText> {
  let plan = req.explain
  if (!plan) {
    try {
      const filter = parseDoc(req.query.query) ?? {}
      plan = await ops.explain(client, req.db, req.coll, { filter, projection: parseDoc(req.query.projection), sort: parseDoc(req.query.sort), skip: Number(req.query.skip) || 0, limit: Number(req.query.limit) || 0 }, 'executionStats')
    } catch {
      plan = undefined
    }
  }
  const user = [
    `Collection: ${req.db}.${req.coll}`,
    `Query:\n${queryLabel(req.query)}`,
    `Indexes:\n${await indexesText(client, req.db, req.coll)}`,
    plan ? `Explain (execution stats):\n${explainText(plan)}` : 'Explain: (not available)',
    await schemaOf(core, client, req.db, req.coll),
    'Explain in plain language what this query does and how MongoDB executes it, then give concrete tuning advice: which index to create (respect the ESR rule: equality, sort, range), projections, and anything risky. Show any index as a db.getCollection(…).createIndex(…) call in a ```javascript block. If the plan is already good, say so briefly.'
  ].join('\n\n')
  const text = await core.complete({ system: `You are a MongoDB performance expert inside Shardwise, a MongoDB GUI. ${STYLE}`, user })
  return { text }
}

export async function explainPlan(core: AiCore, client: MongoClient, req: { db: string; coll: string; explain: Doc; label?: string }): Promise<AiText> {
  const user = [
    `Collection: ${req.db}.${req.coll}`,
    req.label ? `Query: ${req.label}` : '',
    `Indexes:\n${await indexesText(client, req.db, req.coll)}`,
    `Explain output (condensed):\n${explainText(req.explain)}`,
    'Walk through this plan in plain language (stage by stage, from the leaves up), call out the expensive parts (COLLSCAN, in-memory sort, high examined/returned ratio, FETCH after IXSCAN) and give concrete tuning advice following the ESR rule. Show suggested indexes as createIndex calls in a ```javascript block.'
  ]
    .filter(Boolean)
    .join('\n\n')
  const text = await core.complete({ system: `You are a MongoDB performance expert inside Shardwise, a MongoDB GUI. ${STYLE}`, user })
  return { text }
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'corrected find filter in mongo shell syntax ({} for all)' },
    projection: { type: 'string', description: 'corrected projection or empty string' },
    sort: { type: 'string', description: 'corrected sort or empty string' },
    limit: { type: 'string', description: 'limit as digits or empty string' },
    explanation: { type: 'string', description: 'one or two sentences: what was wrong and what changed' }
  },
  required: ['query', 'projection', 'sort', 'limit', 'explanation'],
  additionalProperties: false
}

export async function fixQuery(core: AiCore, client: MongoClient, req: AiFixQueryRequest): Promise<AiFixResult> {
  const user = [
    `Collection: ${req.db}.${req.coll}`,
    `The query bar contains:\n${queryLabel(req.query)}`,
    `It failed (${req.error.part}): ${req.error.message}`,
    await schemaOf(core, client, req.db, req.coll),
    'Correct the query with the smallest change that keeps the intent. Keep parts that were fine as they are.'
  ].join('\n\n')
  return core.json<AiFixResult>({ system: `You fix MongoDB find queries for Shardwise, a MongoDB GUI. ${SHELL} ${READ_ONLY}`, user, schema: FIX_SCHEMA })
}

const PIPELINE_SCHEMA = {
  type: 'object',
  properties: {
    pipeline: { type: 'string', description: 'the stages to add, as a pipeline array in mongo shell syntax, one stage per element' },
    explanation: { type: 'string', description: 'one to three sentences on what the stages do and any assumption' }
  },
  required: ['pipeline', 'explanation'],
  additionalProperties: false
}

export async function generatePipeline(core: AiCore, client: MongoClient, req: AiPipelineRequest): Promise<AiPipelineResult> {
  const user = [
    `Collection: ${req.db}.${req.coll}`,
    await schemaOf(core, client, req.db, req.coll),
    req.current.trim() ? `The editor currently holds this pipeline:\n${req.current}` : 'The editor is empty.',
    `Request: ${req.prompt}`,
    'Return a complete pipeline for the request. The user chooses to replace the current pipeline or to append your stages after it, so when the request extends the current pipeline return only the new stages.'
  ].join('\n\n')
  const r = await core.json<AiPipelineResult>({ system: `You write MongoDB aggregation pipelines for Shardwise, a MongoDB GUI. ${SHELL} ${READ_ONLY}`, user, schema: PIPELINE_SCHEMA })
  try {
    const w = findWriteStage(parseShellValue(r.pipeline))
    if (w) r.explanation = `${r.explanation} Note: the pipeline contains ${w}, which writes data.`
  } catch {
    // The editor reports syntax errors itself.
  }
  return r
}

export async function explainStage(core: AiCore, client: MongoClient, req: AiExplainStageRequest): Promise<AiText> {
  const user = [
    `Collection: ${req.db}.${req.coll}`,
    await schemaOf(core, client, req.db, req.coll),
    `Pipeline:\n${req.pipeline}`,
    `Explain stage ${req.index + 1} in plain language: what it receives, what it does to each document and what it outputs. Mention pitfalls (memory limits, missing fields, types, index use) only when relevant. Keep it short.`
  ].join('\n\n')
  const text = await core.complete({ system: `You explain MongoDB aggregation pipelines inside Shardwise, a MongoDB GUI. ${STYLE}`, user })
  return { text }
}

const CODE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'the code to insert, without markdown fences' },
    explanation: { type: 'string', description: 'one or two sentences on what the code does' }
  },
  required: ['code', 'explanation'],
  additionalProperties: false
}

const PLAYGROUND = `The playground runs JavaScript or TypeScript (Node.js) with: db (the current database, mongosh-like: db.orders.find({…}).limit(5), db.getCollection('x')), client (MongoClient), mongoose (model names map to collections, User -> users, no schema needed), ObjectId, ISODate, use('otherDb'), console.log, top-level await. The value of the last expression (or a top-level return) is shown as the result; cursors are shown as documents.`

export async function generateCode(core: AiCore, client: MongoClient, req: AiCodeRequest): Promise<AiCodeResult> {
  let colls = ''
  try {
    colls = (await ops.listCollections(client, req.db)).map((c) => c.name).join(', ')
  } catch {
    colls = '(unavailable)'
  }
  const user = [
    `Database: ${req.db}\nCollections: ${colls || '(none)'}`,
    `Language: ${req.language}`,
    req.code.trim() ? `Current script:\n${req.code.slice(0, 12000)}` : 'The script is empty.',
    req.selection.trim() ? `Selected text (your code replaces it):\n${req.selection}` : 'Your code is inserted at the cursor.',
    `Request: ${req.prompt}`
  ].join('\n\n')
  return core.json<AiCodeResult>({
    system: `You write scripts for the Shardwise playground. ${PLAYGROUND} Write idiomatic, runnable code that fits the existing script. Prefer reads; only write data when the request asks for it, and then add a short comment saying so. Nothing runs automatically.`,
    user,
    schema: CODE_SCHEMA
  })
}
