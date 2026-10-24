import { syntaxTree } from '@codemirror/language'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'

export interface CompletionData {
  collections: string[]
  databases: string[]
}

const fn = (label: string, detail: string, apply = `${label}()`, info?: string): Completion => ({ label, detail, apply, type: 'function', info })
const method = (label: string, detail = '', info?: string): Completion => ({ label, detail, type: 'method', apply: label, info })

const GLOBALS: Completion[] = [
  { label: 'db', type: 'variable', detail: 'current database', boost: 3 },
  { label: 'client', type: 'variable', detail: 'MongoClient' },
  { label: 'mongoose', type: 'namespace', detail: 'Mongoose (bound to this connection)' },
  { label: 'console', type: 'variable' },
  fn('use', "use('db')", "use('')", 'Switch the current database'),
  fn('model', "model('Name', schema?, 'collection'?)", "model('')", 'Get or define a Mongoose model'),
  { label: 'Schema', type: 'class', detail: 'mongoose.Schema', apply: 'new Schema({  })' },
  fn('print', '…args'),
  fn('printjson', 'value'),
  fn('sleep', 'ms', 'await sleep(1000)'),
  fn('ObjectId', 'BSON', 'ObjectId("")'),
  fn('ISODate', 'BSON', 'ISODate("")'),
  fn('NumberLong', 'BSON', 'NumberLong("")'),
  fn('NumberInt', 'BSON', 'NumberInt()'),
  fn('NumberDecimal', 'BSON', 'NumberDecimal("")'),
  fn('UUID', 'BSON', 'UUID("")'),
  fn('Timestamp', 'BSON', 'Timestamp(0, 0)'),
  fn('BinData', 'BSON', 'BinData(0, "")'),
  { label: 'Long', type: 'class', detail: 'BSON' },
  { label: 'Int32', type: 'class', detail: 'BSON' },
  { label: 'Double', type: 'class', detail: 'BSON' },
  { label: 'Decimal128', type: 'class', detail: 'BSON' },
  { label: 'EJSON', type: 'namespace', detail: 'BSON' }
]

const DB_METHODS: Completion[] = [
  method('getCollection', "('name')"),
  method('getCollectionNames', '()'),
  method('getCollectionInfos', '(filter?)'),
  method('getName', '()'),
  method('getSiblingDB', "('db')"),
  method('createCollection', "('name', options?)"),
  method('createView', "('name', 'source', pipeline)"),
  method('runCommand', '({ … })'),
  method('adminCommand', '({ … })'),
  method('aggregate', '(pipeline)'),
  method('stats', '()'),
  method('serverStatus', '()'),
  method('hostInfo', '()'),
  method('version', '()'),
  method('currentOp', '(filter?)'),
  method('killOp', '(opid)'),
  method('getProfilingStatus', '()'),
  method('setProfilingLevel', '(level, slowms?)'),
  method('dropDatabase', '()')
]
const DB_METHOD_NAMES = new Set(DB_METHODS.map((m) => m.label))

const COLLECTION_METHODS: Completion[] = [
  method('find', '(filter, projection?)'),
  method('findOne', '(filter, projection?)'),
  method('aggregate', '([pipeline])'),
  method('countDocuments', '(filter)'),
  method('estimatedDocumentCount', '()'),
  method('distinct', "('field', filter?)"),
  method('insertOne', '(doc)'),
  method('insertMany', '([docs])'),
  method('updateOne', '(filter, update)'),
  method('updateMany', '(filter, update)'),
  method('replaceOne', '(filter, doc)'),
  method('deleteOne', '(filter)'),
  method('deleteMany', '(filter)'),
  method('findOneAndUpdate', '(filter, update)'),
  method('findOneAndReplace', '(filter, doc)'),
  method('findOneAndDelete', '(filter)'),
  method('bulkWrite', '([ops])'),
  method('createIndex', '(keys, options?)'),
  method('createIndexes', '([keys])'),
  method('getIndexes', '()'),
  method('dropIndex', "('name')"),
  method('dropIndexes', '()'),
  method('drop', '()'),
  method('renameCollection', "('newName')"),
  method('stats', '()'),
  method('explain', "('executionStats')")
]

const CURSOR_METHODS: Completion[] = [
  'limit',
  'skip',
  'sort',
  'project',
  'projection',
  'hint',
  'maxTimeMS',
  'batchSize',
  'collation',
  'comment',
  'toArray',
  'count',
  'explain',
  'forEach',
  'map',
  'next',
  'hasNext',
  'itcount',
  'pretty'
].map((m) => method(m, 'cursor'))

const QUERY_METHODS: Completion[] = [
  'where',
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'ne',
  'or',
  'and',
  'regex',
  'exists',
  'elemMatch',
  'sort',
  'limit',
  'skip',
  'select',
  'lean',
  'populate',
  'exec',
  'countDocuments',
  'distinct',
  'cursor',
  'explain'
].map((m) => method(m, 'mongoose query'))

const MODEL_METHODS: Completion[] = [
  'find',
  'findOne',
  'findById',
  'where',
  'countDocuments',
  'estimatedDocumentCount',
  'exists',
  'distinct',
  'aggregate',
  'create',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'findOneAndDelete',
  'findByIdAndDelete',
  'bulkWrite',
  'populate',
  'syncIndexes',
  'listIndexes'
].map((m) => method(m, 'mongoose model'))

const MONGOOSE_MEMBERS: Completion[] = [
  method('model', "('Name', schema, 'collection'?)"),
  { label: 'Schema', type: 'class', detail: 'mongoose' },
  { label: 'Types', type: 'namespace', detail: 'ObjectId, Decimal128, …' },
  { label: 'connection', type: 'property' },
  { label: 'models', type: 'property' },
  method('isValidObjectId', '(value)'),
  method('set', "('option', value)"),
  method('pluralize', '()')
]

const OPERATORS = [
  // query
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$elemMatch', '$all', '$size', '$mod', '$text', '$search', '$where', '$expr', '$jsonSchema', '$geoWithin', '$geoIntersects', '$near',
  '$nearSphere', '$slice',
  // update
  '$set', '$unset', '$inc', '$mul', '$rename', '$min', '$max', '$currentDate', '$setOnInsert', '$push', '$pull', '$pullAll', '$addToSet',
  '$pop', '$each', '$position', '$sort',
  // pipeline stages
  '$match', '$group', '$project', '$limit', '$skip', '$unwind', '$lookup', '$addFields', '$count', '$facet', '$bucket', '$bucketAuto',
  '$sortByCount', '$replaceRoot', '$replaceWith', '$sample', '$out', '$merge', '$graphLookup', '$unionWith', '$setWindowFields',
  '$densify', '$fill', '$geoNear', '$redact', '$indexStats', '$collStats',
  // expressions & accumulators
  '$sum', '$avg', '$first', '$last', '$cond', '$ifNull', '$switch', '$concat', '$substr', '$toUpper', '$toLower', '$trim', '$split',
  '$dateToString', '$dateAdd', '$dateDiff', '$year', '$month', '$dayOfMonth', '$arrayElemAt', '$filter', '$map', '$reduce', '$let',
  '$literal', '$toString', '$toInt', '$toLong', '$toDouble', '$toDecimal', '$toDate', '$toObjectId', '$round', '$add', '$subtract',
  '$multiply', '$divide', '$mergeObjects', '$objectToArray', '$arrayToObject', '$regexMatch', '$isArray', '$size'
]
const OPERATOR_OPTIONS: Completion[] = [...new Set(OPERATORS)].map((o) => ({ label: o, type: 'keyword' }))

const IDENT = /^[A-Za-z_$][\w$]*$/

/** Model name a collection is reachable by (customers → Customer, categories → Category). */
export function modelNameFor(coll: string): string | null {
  const base = coll.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/([^s])s$/, '$1')
  const name = base.charAt(0).toUpperCase() + base.slice(1)
  return IDENT.test(name) ? name : null
}

export function playgroundCompletions(get: () => CompletionData) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
    const inString = node.name === 'String' || node.name === 'TemplateString'
    const { collections, databases } = get()

    let m = /\b(?:db\.getCollection|getSiblingDB|use)\(\s*(['"`])([^'"`]*)$/.exec(before)
    if (m) {
      const list = before.includes('getCollection') ? collections : databases
      return { from: ctx.pos - m[2].length, options: list.map((c) => ({ label: c, type: 'property' })), validFor: /^[^'"`]*$/ }
    }
    if (inString || node.name.includes('Comment')) return null

    m = /\$[\w]*$/.exec(before)
    if (m) return { from: ctx.pos - m[0].length, options: OPERATOR_OPTIONS, validFor: /^\$\w*$/ }

    const props = (opts: Completion[], typed: string): CompletionResult => ({ from: ctx.pos - typed.length, options: opts, validFor: /^[\w$]*$/ })

    m = /\bdb\.([\w$]+)\.([\w$]*)$/.exec(before)
    if (m && !DB_METHOD_NAMES.has(m[1])) return props(COLLECTION_METHODS, m[2])
    m = /\bdb\.getCollection\([^)]*\)\.([\w$]*)$/.exec(before)
    if (m) return props(COLLECTION_METHODS, m[1])
    m = /\bdb\.([\w$]*)$/.exec(before)
    if (m) {
      const colls = collections.map((c): Completion => (IDENT.test(c) ? { label: c, type: 'property', detail: 'collection', boost: 2 } : { label: c, type: 'property', detail: 'collection', apply: `getCollection('${c}')`, boost: 2 }))
      return props([...colls, ...DB_METHODS], m[1])
    }
    m = /\bmongoose\.([\w$]*)$/.exec(before)
    if (m) return props(MONGOOSE_MEMBERS, m[1])
    m = /\b[A-Z][\w$]*\.([\w$]*)$/.exec(before)
    if (m) return props(MODEL_METHODS, m[1])
    m = /\)\s*\.([\w$]*)$/.exec(before)
    if (m) return props([...CURSOR_METHODS, ...QUERY_METHODS.filter((q) => !CURSOR_METHODS.some((c) => c.label === q.label))], m[1])
    if (/\.\s*[\w$]*$/.test(before)) return null

    const word = ctx.matchBefore(/[\w$]+/)
    if (!word && !ctx.explicit) return null
    const models = [...new Set(collections.map(modelNameFor).filter((n): n is string => !!n))].map(
      (n): Completion => ({ label: n, type: 'class', detail: 'Mongoose model (auto)' })
    )
    return { from: word ? word.from : ctx.pos, options: [...GLOBALS, ...models], validFor: /^[\w$]*$/ }
  }
}
