import type { AggregateOptions as DriverAggregateOptions, CollationOptions, Document, MongoClient } from 'mongodb'
import type { AggregateOptions, AggregateResult, Doc } from '@shared/api'
import { MAX_RESULT_DOCS } from '@shared/pipeline'
import { RAW_TYPES } from './ops'

type Verbosity = 'queryPlanner' | 'executionStats' | 'allPlansExecution'

function driverOptions(opts: AggregateOptions): DriverAggregateOptions {
  const o: DriverAggregateOptions = { ...RAW_TYPES }
  if (opts.allowDiskUse) o.allowDiskUse = true
  if (opts.maxTimeMS && opts.maxTimeMS > 0) o.maxTimeMS = opts.maxTimeMS
  if (opts.collation && Object.keys(opts.collation).length) o.collation = opts.collation as unknown as CollationOptions
  return o
}

/**
 * Run a pipeline. Returns at most MAX_RESULT_DOCS + 1 documents: one more than the cap means the
 * result was truncated (previews pass their own trailing $limit).
 */
export async function aggregate(client: MongoClient, db: string, coll: string, pipeline: Doc[], opts: AggregateOptions = {}): Promise<AggregateResult> {
  const t0 = performance.now()
  const cursor = client
    .db(db)
    .collection(coll)
    .aggregate(pipeline as Document[], { ...driverOptions(opts), batchSize: Math.min(MAX_RESULT_DOCS + 1, 1000) })
  const docs: Doc[] = []
  try {
    for await (const d of cursor) {
      docs.push(d as Doc)
      if (docs.length > MAX_RESULT_DOCS) break
    }
  } finally {
    await cursor.close().catch(() => {})
  }
  return { docs, ms: Math.round(performance.now() - t0) }
}

export async function explainAggregate(
  client: MongoClient,
  db: string,
  coll: string,
  pipeline: Doc[],
  opts: AggregateOptions = {},
  verbosity: Verbosity = 'queryPlanner'
): Promise<Doc> {
  const o = driverOptions(opts)
  delete o.promoteValues
  delete o.promoteLongs
  return (await client
    .db(db)
    .collection(coll)
    .aggregate(pipeline as Document[], o)
    .explain(verbosity)) as Doc
}

export async function createView(client: MongoClient, db: string, name: string, viewOn: string, pipeline: Doc[]): Promise<void> {
  if (!name.trim()) throw new Error('View name is required')
  await client.db(db).createCollection(name, { viewOn, pipeline: pipeline as Document[] })
}
