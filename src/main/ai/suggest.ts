import type { MongoClient } from 'mongodb'
import type { AiRequest, AiSuggestion } from '@shared/api'
import type { AiCore } from './client'
import { collectionContext } from './context'

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['find', 'aggregate'] },
    query: { type: 'string', description: 'find filter in mongo shell syntax, e.g. { status: "paid" }; empty string for aggregate' },
    projection: { type: 'string', description: 'find projection or empty string' },
    sort: { type: 'string', description: 'find sort or empty string' },
    limit: { type: 'string', description: 'find limit as digits or empty string' },
    pipeline: { type: 'string', description: 'aggregation pipeline array in mongo shell syntax; empty string for find' },
    explanation: { type: 'string', description: 'one or two sentences on what the query does and any assumption made' }
  },
  required: ['kind', 'query', 'projection', 'sort', 'limit', 'pipeline', 'explanation'],
  additionalProperties: false
}

const SYSTEM = `You write MongoDB queries for Shardwise, a MongoDB GUI. The user describes what they want in natural language; you answer with a single query for the given collection.

Rules:
- Prefer a find query (filter, projection, sort, limit). Use an aggregation pipeline only when the request needs grouping, joins ($lookup), computed fields, or reshaping.
- Write mongo shell syntax: ObjectId('…'), ISODate('…'), NumberLong(…), NumberDecimal('…'), regex literals /…/i. Unquoted keys are fine.
- Use only fields that exist in the schema you are given, matching their stored types (compare ObjectId fields with ObjectId, dates with ISODate, Decimal128 with NumberDecimal).
- Never write stages or operators that modify data ($out, $merge, updates, deletes). The query is shown to the user for review; nothing runs automatically.
- Leave unused fields as empty strings. If the request is ambiguous, pick the most reasonable reading and say so in the explanation.`

/** "Ask AI" in the query bar: natural language → one find query or pipeline. */
export async function suggestQuery(core: AiCore, client: MongoClient, req: AiRequest): Promise<AiSuggestion> {
  // The dialog's own checkbox (defaulting to the "send sample values" preference) decides.
  let context = `Database: ${req.db}\nCollection: ${req.coll}\n\n${await collectionContext(client, req.db, req.coll, req.includeSamples)}`
  const cur = req.current
  if (cur && (cur.query.trim() || cur.sort.trim() || cur.projection.trim())) {
    context += `\n\nThe query bar currently contains:\nquery: ${cur.query || '{}'}\nprojection: ${cur.projection || '(none)'}\nsort: ${cur.sort || '(none)'}`
  }
  return core.json<AiSuggestion>({ system: SYSTEM, user: `${context}\n\nRequest: ${req.prompt}`, schema: SCHEMA })
}
