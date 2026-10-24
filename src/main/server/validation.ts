import type { Document, MongoClient } from 'mongodb'
import type { Doc } from '@shared/api'
import { VALIDATION_ACTIONS, VALIDATION_LEVELS } from '@shared/serverApi'
import type { ValidationAction, ValidationLevel, ValidationRules, ValidationState, ValidationTestResult, ViewDefinition } from '@shared/serverApi'

const RAW = { promoteValues: false, promoteLongs: false } as const
const MAX_FAILURES = 20

/** `listCollections` entry of one namespace, keeping BSON number types of the options. */
async function collectionInfo(client: MongoClient, db: string, name: string): Promise<Doc> {
  const r = (await client.db(db).command({ listCollections: 1, filter: { name } }, RAW)) as { cursor?: { firstBatch?: Doc[] } }
  const info = r.cursor?.firstBatch?.[0]
  if (!info) throw new Error(`${db}.${name} does not exist`)
  return info
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [a, b] = version.split('.').map((x) => parseInt(x, 10) || 0)
  return a > major || (a === major && b >= minor)
}

async function serverVersion(client: MongoClient): Promise<string> {
  const b = await client.db('admin').command({ buildInfo: 1 })
  return String(b.version ?? '')
}

export async function getValidation(client: MongoClient, db: string, coll: string): Promise<ValidationState> {
  const info = await collectionInfo(client, db, coll)
  if (info.type === 'view') throw new Error(`${coll} is a view: views have no validation rules`)
  const o = (info.options ?? {}) as Doc
  const v = o.validator as Doc | undefined
  const version = await serverVersion(client)
  const level = (VALIDATION_LEVELS as readonly string[]).includes(String(o.validationLevel)) ? (o.validationLevel as ValidationLevel) : 'strict'
  const action = (VALIDATION_ACTIONS as readonly string[]).includes(String(o.validationAction)) ? (o.validationAction as ValidationAction) : 'error'
  return {
    validator: v && Object.keys(v).length ? v : null,
    level,
    action,
    serverVersion: version,
    actions: versionAtLeast(version, 8, 1) ? [...VALIDATION_ACTIONS] : ['error', 'warn']
  }
}

export async function setValidation(client: MongoClient, db: string, coll: string, rules: ValidationRules): Promise<ValidationState> {
  if (!(VALIDATION_LEVELS as readonly string[]).includes(rules.level)) throw new Error(`Unknown validation level ${rules.level}`)
  if (!(VALIDATION_ACTIONS as readonly string[]).includes(rules.action)) throw new Error(`Unknown validation action ${rules.action}`)
  if (rules.validator != null && (typeof rules.validator !== 'object' || Array.isArray(rules.validator))) throw new Error('The validator must be a document')
  await client.db(db).command({ collMod: coll, validator: rules.validator ?? {}, validationLevel: rules.level, validationAction: rules.action })
  return getValidation(client, db, coll)
}

/** Count the (sampled) documents that do not match `validator` and return the first failing ones. */
export async function testValidation(client: MongoClient, db: string, coll: string, validator: Doc, sample = 1000): Promise<ValidationTestResult> {
  if (!validator || typeof validator !== 'object' || Array.isArray(validator)) throw new Error('The validator must be a document')
  const t0 = performance.now()
  const c = client.db(db).collection(coll)
  const total = await c.estimatedDocumentCount()
  const fail = { $match: { $nor: [validator] } }
  const pipeline: Document[] = []
  if (sample > 0 && sample < total) pipeline.push({ $sample: { size: sample } })
  pipeline.push({
    $facet: {
      sampled: [{ $count: 'n' }],
      failed: [fail, { $count: 'n' }],
      ids: [fail, { $limit: MAX_FAILURES }, { $project: { _id: 1 } }]
    }
  })
  const [r] = (await c.aggregate(pipeline, { allowDiskUse: true }).toArray()) as { sampled: { n: number }[]; failed: { n: number }[]; ids: { _id: unknown }[] }[]
  const sampled = r?.sampled[0]?.n ?? 0
  const failed = r?.failed[0]?.n ?? 0
  const ids = (r?.ids ?? []).map((d) => d._id)
  const docs = ids.length ? ((await c.find({ _id: { $in: ids } } as Document, RAW).toArray()) as Doc[]) : []
  const order = new Map(ids.map((id, i) => [JSON.stringify(id), i]))
  docs.sort((a, b) => (order.get(JSON.stringify(a._id)) ?? 0) - (order.get(JSON.stringify(b._id)) ?? 0))
  return { sampled, failed, passed: sampled - failed, total, failures: docs, ms: Math.round(performance.now() - t0) }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const WRITE_STAGES = ['$out', '$merge']

export async function getView(client: MongoClient, db: string, name: string): Promise<ViewDefinition> {
  const info = await collectionInfo(client, db, name)
  if (info.type !== 'view') throw new Error(`${name} is not a view`)
  const o = (info.options ?? {}) as Doc
  return { name, viewOn: String(o.viewOn ?? ''), pipeline: (o.pipeline as Doc[] | undefined) ?? [] }
}

export async function updateView(client: MongoClient, db: string, name: string, viewOn: string, pipeline: Doc[]): Promise<void> {
  if (!viewOn.trim()) throw new Error('The view needs a source collection')
  const bad = pipeline.map((s) => Object.keys(s)[0]).find((op) => WRITE_STAGES.includes(op))
  if (bad) throw new Error(`A view cannot contain a ${bad} stage`)
  await getView(client, db, name)
  await client.db(db).command({ collMod: name, viewOn, pipeline })
}
