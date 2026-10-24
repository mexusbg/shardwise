import { toJSString } from 'mongodb-query-parser'
import { isPlainDoc, parseShellValue } from './bsonValue'
import type { Doc } from './api'

/** One stage of the aggregation editor; `body` is the shell-syntax text of the stage value. */
export interface Stage {
  id: string
  op: string
  body: string
  enabled: boolean
}

export interface StageTemplate {
  op: string
  body: string
  info: string
  group: 'common' | 'more' | 'atlas' | 'output'
}

export const STAGE_TEMPLATES: StageTemplate[] = [
  { op: '$match', group: 'common', info: 'Filter documents', body: "{\n  // field: 'value'\n}" },
  { op: '$project', group: 'common', info: 'Include, exclude or compute fields', body: '{\n  _id: 1\n  // field: 1\n}' },
  { op: '$addFields', group: 'common', info: 'Add computed fields', body: "{\n  // newField: '$field'\n}" },
  { op: '$set', group: 'common', info: 'Alias of $addFields', body: "{\n  // newField: '$field'\n}" },
  { op: '$unset', group: 'common', info: 'Remove fields', body: "'field'" },
  { op: '$group', group: 'common', info: 'Group by a key and accumulate', body: "{\n  _id: '$field',\n  count: { $sum: 1 }\n}" },
  { op: '$sort', group: 'common', info: 'Sort documents', body: '{\n  _id: 1\n}' },
  { op: '$limit', group: 'common', info: 'Pass the first n documents', body: '10' },
  { op: '$skip', group: 'common', info: 'Skip the first n documents', body: '0' },
  { op: '$unwind', group: 'common', info: 'One document per array element', body: "{\n  path: '$field',\n  preserveNullAndEmptyArrays: true\n}" },
  {
    op: '$lookup',
    group: 'common',
    info: 'Join another collection',
    body: "{\n  from: 'collection',\n  localField: 'field',\n  foreignField: '_id',\n  as: 'joined'\n}"
  },
  { op: '$count', group: 'common', info: 'Count the documents', body: "'count'" },
  {
    op: '$facet',
    group: 'common',
    info: 'Several sub-pipelines on the same input',
    body: "{\n  byField: [\n    { $group: { _id: '$field', count: { $sum: 1 } } }\n  ],\n  total: [\n    { $count: 'count' }\n  ]\n}"
  },
  {
    op: '$graphLookup',
    group: 'more',
    info: 'Recursive lookup',
    body: "{\n  from: 'collection',\n  startWith: '$field',\n  connectFromField: 'field',\n  connectToField: '_id',\n  as: 'hierarchy',\n  maxDepth: 3\n}"
  },
  {
    op: '$bucket',
    group: 'more',
    info: 'Group into ranges',
    body: "{\n  groupBy: '$field',\n  boundaries: [0, 100, 1000],\n  default: 'other',\n  output: { count: { $sum: 1 } }\n}"
  },
  { op: '$bucketAuto', group: 'more', info: 'Group into n even buckets', body: "{\n  groupBy: '$field',\n  buckets: 5\n}" },
  { op: '$sortByCount', group: 'more', info: 'Group, count and sort by count', body: "'$field'" },
  { op: '$replaceRoot', group: 'more', info: 'Replace the document', body: "{\n  newRoot: '$$ROOT'\n}" },
  { op: '$replaceWith', group: 'more', info: 'Replace the document', body: "'$$ROOT'" },
  { op: '$sample', group: 'more', info: 'Random documents', body: '{\n  size: 10\n}' },
  {
    op: '$densify',
    group: 'more',
    info: 'Fill gaps in a sequence',
    body: "{\n  field: 'date',\n  range: {\n    step: 1,\n    unit: 'day',\n    bounds: 'full'\n  }\n}"
  },
  { op: '$fill', group: 'more', info: 'Fill null / missing values', body: "{\n  sortBy: { _id: 1 },\n  output: {\n    field: { method: 'linear' }\n  }\n}" },
  {
    op: '$setWindowFields',
    group: 'more',
    info: 'Window functions',
    body: "{\n  partitionBy: '$field',\n  sortBy: { _id: 1 },\n  output: {\n    runningCount: {\n      $sum: 1,\n      window: { documents: ['unbounded', 'current'] }\n    }\n  }\n}"
  },
  { op: '$unionWith', group: 'more', info: 'Append another collection', body: "{\n  coll: 'collection',\n  pipeline: []\n}" },
  {
    op: '$geoNear',
    group: 'more',
    info: 'Sort by distance (must be first)',
    body: "{\n  near: { type: 'Point', coordinates: [0, 0] },\n  distanceField: 'distance',\n  spherical: true\n}"
  },
  {
    op: '$redact',
    group: 'more',
    info: 'Prune content by condition',
    body: "{\n  $cond: {\n    if: { $eq: ['$level', 5] },\n    then: '$$PRUNE',\n    else: '$$DESCEND'\n  }\n}"
  },
  { op: '$collStats', group: 'more', info: 'Collection statistics (must be first)', body: '{\n  storageStats: {}\n}' },
  { op: '$indexStats', group: 'more', info: 'Index usage (must be first)', body: '{}' },
  { op: '$search', group: 'atlas', info: 'Atlas Search (must be first)', body: "{\n  index: 'default',\n  text: {\n    query: 'text',\n    path: { wildcard: '*' }\n  }\n}" },
  { op: '$searchMeta', group: 'atlas', info: 'Atlas Search metadata (must be first)', body: "{\n  index: 'default',\n  count: { type: 'total' }\n}" },
  {
    op: '$vectorSearch',
    group: 'atlas',
    info: 'Atlas Vector Search (must be first)',
    body: "{\n  index: 'vector_index',\n  path: 'embedding',\n  queryVector: [],\n  numCandidates: 100,\n  limit: 10\n}"
  },
  { op: '$out', group: 'output', info: 'Write the results to a collection', body: "'output_collection'" },
  {
    op: '$merge',
    group: 'output',
    info: 'Merge the results into a collection',
    body: "{\n  into: 'output_collection',\n  on: '_id',\n  whenMatched: 'merge',\n  whenNotMatched: 'insert'\n}"
  }
]

export const STAGE_OPERATORS = STAGE_TEMPLATES.map((t) => t.op)

/** Stages that must open the pipeline: previews put their sampling $limit after them. */
export const FIRST_STAGES = new Set([
  '$geoNear',
  '$search',
  '$searchMeta',
  '$vectorSearch',
  '$collStats',
  '$indexStats',
  '$currentOp',
  '$listSessions',
  '$listLocalSessions',
  '$planCacheStats',
  '$listSearchIndexes',
  '$documents',
  '$changeStream',
  '$querySettings',
  '$listSampledQueries'
])

/** Stages that write data: skipped in previews, confirmed before a full run. */
export const OUTPUT_STAGES = new Set(['$out', '$merge'])

/** Full runs return at most this many documents (the server returns one more to signal truncation). */
export const MAX_RESULT_DOCS = 1000

export const AGG_EXPRESSION_OPERATORS = [
  '$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet', '$count', '$top', '$bottom', '$topN', '$bottomN',
  '$firstN', '$lastN', '$maxN', '$minN', '$stdDevPop', '$stdDevSamp', '$mergeObjects', '$median', '$percentile',
  '$add', '$subtract', '$multiply', '$divide', '$mod', '$abs', '$ceil', '$floor', '$round', '$trunc', '$pow', '$sqrt', '$exp', '$ln', '$log10',
  '$concat', '$substr', '$substrCP', '$toLower', '$toUpper', '$trim', '$ltrim', '$rtrim', '$split', '$strLenCP', '$regexMatch', '$regexFind',
  '$replaceAll', '$replaceOne', '$indexOfCP', '$strcasecmp', '$cmp', '$cond', '$ifNull', '$switch', '$and', '$or', '$not', '$eq', '$ne',
  '$gt', '$gte', '$lt', '$lte', '$in', '$arrayElemAt', '$concatArrays', '$filter', '$map', '$reduce', '$size', '$slice', '$sortArray',
  '$reverseArray', '$range', '$zip', '$isArray', '$arrayToObject', '$objectToArray', '$getField', '$setField', '$let', '$literal',
  '$dateToString', '$dateFromString', '$dateAdd', '$dateSubtract', '$dateDiff', '$dateTrunc', '$year', '$month', '$dayOfMonth',
  '$dayOfWeek', '$dayOfYear', '$hour', '$minute', '$second', '$week', '$toDate', '$toString', '$toInt', '$toLong', '$toDouble',
  '$toDecimal', '$toObjectId', '$toBool', '$convert', '$type', '$isNumber', '$expr', '$elemMatch', '$exists', '$regex',
  '$documentNumber', '$rank', '$denseRank', '$shift', '$derivative', '$integral', '$expMovingAvg', '$covariancePop', '$locf', '$linearFill'
]

let seq = 0
export const newStageId = (): string => `st${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const templateFor = (op: string): string => STAGE_TEMPLATES.find((t) => t.op === op)?.body ?? '{}'

export function newStage(op = '$match', body?: string, enabled = true): Stage {
  return { id: newStageId(), op, body: body ?? templateFor(op), enabled }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `{a:1}` → `{ a: 1 }` (strings untouched). */
function spaced(s: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      out += c
      if (c === '\\') out += s[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      out += c
    } else if (c === '{' && s[i + 1] !== '}') out += '{ '
    else if (c === '}' && s[i - 1] !== '{') out += ' }'
    else if (c === ':') out += ': '
    else if (c === ',') out += ', '
    else out += c
  }
  return out
}

/** Shell text of a value: one line when short, indented otherwise. */
export function formatValue(v: unknown, width = 80): string {
  const flat = toJSString(v as object, 0) ?? String(v)
  if (flat.length <= width) return spaced(flat)
  return toJSString(v as object, 2) ?? flat
}

/** Remove the common indentation of all lines but the first. */
function dedent(text: string): string {
  const lines = text.split('\n')
  if (lines.length < 2) return text
  const rest = lines.slice(1).filter((l) => l.trim())
  const min = Math.min(...rest.map((l) => /^[ \t]*/.exec(l)![0].length))
  if (!min || !Number.isFinite(min)) return text
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)))].join('\n')
}

const indent = (text: string, pad: string): string =>
  text
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n')

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

export class StageError extends Error {
  constructor(
    public index: number,
    message: string
  ) {
    super(message)
  }
}

/** Parser messages refer to a wrapped source; translate the position and drop the echoed source. */
function cleanMessage(m: string, prefixLen: number): string {
  let msg = m.replace(/\s+in\s*\([\s\S]*\)\s*$/, '').trim()
  msg = msg.replace(/\((\d+):(\d+)\)/, (_, l: string, c: string) => {
    const line = Math.max(1, Number(l) - 1)
    const col = Math.max(1, Number(c) - (line === 1 ? prefixLen : 0) + 1)
    return `(line ${line}, column ${col})`
  })
  return msg
}

function parseText(text: string): unknown {
  try {
    return parseShellValue(text)
  } catch (e) {
    throw new Error(cleanMessage((e as Error).message, 6))
  }
}

const kindOf = (v: unknown): string => (Array.isArray(v) ? 'an array' : isPlainDoc(v) ? 'an object' : typeof v === 'string' ? 'a string' : `a ${typeof v}`)

function checkShape(op: string, v: unknown): void {
  const isNum = typeof v === 'number' || ['Int32', 'Long', 'Double'].includes((v as { _bsontype?: string } | null)?._bsontype ?? '')
  switch (op) {
    case '$limit':
    case '$skip':
      if (!isNum || Number(v) < 0 || !Number.isInteger(Number(v))) throw new Error(`${op} takes a non-negative integer`)
      if (op === '$limit' && Number(v) === 0) throw new Error('$limit must be positive')
      return
    case '$count':
      if (typeof v !== 'string' || !v) throw new Error('$count takes the name of the output field')
      return
    case '$unset':
      if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new Error('$unset takes a field name or an array of names')
      return
    case '$unwind':
      if (typeof v === 'string' && !v.startsWith('$')) throw new Error("$unwind takes a field path such as '$items' or an object")
      if (typeof v !== 'string' && !isPlainDoc(v)) throw new Error("$unwind takes a field path such as '$items' or an object")
      return
    case '$out':
    case '$merge':
    case '$unionWith':
      if (typeof v !== 'string' && !isPlainDoc(v)) throw new Error(`${op} takes a collection name or an object`)
      return
    case '$sortByCount':
    case '$replaceWith':
      return
    case '$documents':
      if (!Array.isArray(v)) throw new Error('$documents takes an array')
      return
    default:
      if (!isPlainDoc(v)) throw new Error(`${op} takes an object, not ${kindOf(v)}`)
  }
}

/** Value of one stage, `{ [op]: body }`. Throws a readable Error. */
export function stageValue(stage: Pick<Stage, 'op' | 'body'>): Doc {
  if (!/^\$[A-Za-z]\w*$/.test(stage.op)) throw new Error(`'${stage.op}' is not a stage operator`)
  if (!stage.body.trim()) throw new Error('Stage body is empty')
  const v = parseText(stage.body)
  checkShape(stage.op, v)
  return { [stage.op]: v }
}

export function stageError(stage: Pick<Stage, 'op' | 'body'>): string | null {
  try {
    stageValue(stage)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** Pipeline documents of the enabled stages. Throws StageError naming the first invalid stage. */
export function pipelineDocs(stages: Stage[], all = false): Doc[] {
  const out: Doc[] = []
  stages.forEach((s, i) => {
    if (!all && !s.enabled) return
    try {
      out.push(stageValue(s))
    } catch (e) {
      throw new StageError(i, `Stage ${i + 1} (${s.op}): ${(e as Error).message}`)
    }
  })
  return out
}

export const hasOutputStage = (stages: Stage[]): boolean => stages.some((s) => s.enabled && OUTPUT_STAGES.has(s.op))

// ---------------------------------------------------------------------------
// Pipeline text (two-way)
// ---------------------------------------------------------------------------

export const DISABLED_MARK = '/* disabled */'

/** Shell-syntax array of the stages. Disabled stages are included, marked with a comment, when `includeDisabled`. */
export function pipelineText(stages: Stage[], includeDisabled = false): string {
  const items = stages
    .filter((s) => includeDisabled || s.enabled)
    .map((s) => {
      const body = s.body.trim() || '{}'
      const mark = s.enabled ? '' : `${DISABLED_MARK} `
      if (!body.includes('\n') && !body.includes('//') && body.length + s.op.length <= 90) return `  ${mark}{ ${s.op}: ${body} }`
      return `  ${mark}{\n    ${s.op}: ${indent(body, '    ')}\n  }`
    })
  if (!items.length) return '[]'
  return `[\n${items.join(',\n')}\n]`
}

interface Element {
  text: string
  disabled: boolean
}

const REGEX_PREV = /[(,=:[!&|?{};+\-*%<>~^]/

/** Top-level elements of an array literal, keeping their source text (comments included). */
function splitArray(src: string): Element[] | null {
  let i = 0
  const n = src.length
  const skipTrivia = (collect?: string[]): void => {
    while (i < n) {
      const c = src[i]
      if (/\s/.test(c)) i++
      else if (c === '/' && src[i + 1] === '/') {
        const e = src.indexOf('\n', i)
        collect?.push(src.slice(i, e < 0 ? n : e))
        i = e < 0 ? n : e
      } else if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2)
        if (e < 0) return
        collect?.push(src.slice(i, e + 2))
        i = e + 2
      } else return
    }
  }
  skipTrivia()
  if (src[i] !== '[') return null
  i++
  const out: Element[] = []
  for (;;) {
    const comments: string[] = []
    skipTrivia(comments)
    if (i >= n) return null
    if (src[i] === ']') break
    const start = i
    let depth = 0
    let prev = ''
    while (i < n) {
      const c = src[i]
      if (c === '"' || c === "'" || c === '`') {
        i++
        while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1
        i++
        prev = c
        continue
      }
      if (c === '/' && src[i + 1] === '/') {
        const e = src.indexOf('\n', i)
        i = e < 0 ? n : e
        continue
      }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2)
        i = e < 0 ? n : e + 2
        continue
      }
      if (c === '/' && (prev === '' || REGEX_PREV.test(prev))) {
        i++
        let cls = false
        while (i < n && (cls || src[i] !== '/')) {
          if (src[i] === '\\') i++
          else if (src[i] === '[') cls = true
          else if (src[i] === ']') cls = false
          i++
        }
        i++
        while (i < n && /[a-z]/i.test(src[i])) i++
        prev = '/'
        continue
      }
      if (c === '{' || c === '[' || c === '(') depth++
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
      if (!/\s/.test(c)) prev = c
      i++
    }
    if (i >= n) return null
    out.push({ text: src.slice(start, i).trim(), disabled: comments.some((c) => c.replace(/\s+/g, ' ') === DISABLED_MARK) })
    if (src[i] === ',') i++
  }
  return out
}

/** Body source of `{ $op: body }`, or null when the element isn't in that simple form. */
function bodyOf(element: string, op: string): string | null {
  const m = /^\{\s*(?:(['"])(\$\w+)\1|(\$\w+))\s*:/.exec(element)
  if (!m || (m[2] ?? m[3]) !== op || !element.endsWith('}')) return null
  let body = element.slice(m[0].length, -1).trim()
  if (body.endsWith(',')) body = body.slice(0, -1).trimEnd()
  return dedent(body)
}

/** Parse a shell-syntax pipeline array into stages. Throws a readable Error when invalid. */
export function stagesFromText(text: string): Stage[] {
  if (!text.trim()) return []
  const v = parseText(text)
  if (!Array.isArray(v)) throw new Error('The pipeline must be an array of stages: [ { $match: … }, … ]')
  const parts = splitArray(text)
  const exact = parts?.length === v.length
  return v.map((st, i) => {
    if (!isPlainDoc(st)) throw new Error(`Stage ${i + 1} is not an object`)
    const keys = Object.keys(st)
    if (keys.length !== 1 || !keys[0].startsWith('$')) throw new Error(`Stage ${i + 1} must have exactly one $operator key (found ${keys.length ? keys.join(', ') : 'none'})`)
    const op = keys[0]
    const raw = exact ? bodyOf(parts![i].text, op) : null
    return { id: newStageId(), op, body: raw ?? formatValue(st[op]), enabled: exact ? !parts![i].disabled : true }
  })
}

/** Keep ids (and so the selection) of stages at the same positions. */
export function keepIds(prev: Stage[], next: Stage[]): Stage[] {
  return next.map((s, i) => (prev[i] ? { ...s, id: prev[i].id } : s))
}

// ---------------------------------------------------------------------------
// From a find query
// ---------------------------------------------------------------------------

export interface FindTexts {
  query?: string
  projection?: string
  sort?: string
  skip?: string | number
  limit?: string | number
}

const isEmptyObjectText = (t: string): boolean => {
  try {
    const v = parseShellValue(t)
    return isPlainDoc(v) && Object.keys(v).length === 0
  } catch {
    return false
  }
}

/** Find query bar texts → $match, $sort, $skip, $limit, $project stages. */
export function stagesFromFind(q: FindTexts): Stage[] {
  const out: Stage[] = []
  const query = q.query?.trim() ?? ''
  const projection = q.projection?.trim() ?? ''
  const sort = q.sort?.trim() ?? ''
  const skip = Number(String(q.skip ?? '').trim() || 0)
  const limit = Math.abs(Number(String(q.limit ?? '').trim() || 0))
  if (query && !isEmptyObjectText(query)) out.push(newStage('$match', query))
  if (sort && !isEmptyObjectText(sort)) out.push(newStage('$sort', sort))
  if (Number.isFinite(skip) && skip > 0) out.push(newStage('$skip', String(Math.floor(skip))))
  if (Number.isFinite(limit) && limit > 0) out.push(newStage('$limit', String(Math.floor(limit))))
  if (projection && !isEmptyObjectText(projection)) out.push(newStage('$project', projection))
  return out
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/**
 * Pipeline that computes the documents entering ('input') or leaving ('output') stage `index` on a sample:
 * a `$limit: sampleSize` is placed first (after any stage that must open the pipeline), disabled and output
 * stages ($out / $merge) are skipped, and the result is capped at `sampleSize`.
 */
export function previewPipeline(stages: Stage[], index: number, sampleSize: number, mode: 'input' | 'output'): Doc[] {
  const n = Math.max(1, Math.floor(sampleSize))
  const end = mode === 'input' ? index : index + 1
  const docs: Doc[] = []
  stages.slice(0, Math.max(0, end)).forEach((s, i) => {
    if (!s.enabled || OUTPUT_STAGES.has(s.op)) return
    try {
      docs.push(stageValue(s))
    } catch (e) {
      throw new StageError(i, `Stage ${i + 1} (${s.op}): ${(e as Error).message}`)
    }
  })
  let lead = 0
  while (lead < docs.length && FIRST_STAGES.has(Object.keys(docs[lead])[0])) lead++
  const out = [...docs.slice(0, lead), { $limit: n }, ...docs.slice(lead)]
  if (out.length > 1) out.push({ $limit: n })
  return out
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** One-line summary of a stage body for collapsed stage cards. */
export function stageSummary(stage: Pick<Stage, 'body'>, max = 120): string {
  const s = stage.body
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\{ \}/g, '{}')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export interface ShellOptions {
  allowDiskUse?: boolean
  maxTimeMS?: number
  collation?: Doc | null
}

/** `db.getCollection('…').aggregate([...], { … })` for the enabled stages. */
export function shellCommand(coll: string, stages: Stage[], o: ShellOptions = {}): string {
  const opts: Doc = {}
  if (o.allowDiskUse) opts.allowDiskUse = true
  if (o.maxTimeMS) opts.maxTimeMS = o.maxTimeMS
  if (o.collation && Object.keys(o.collation).length) opts.collation = o.collation
  const optText = Object.keys(opts).length ? `, ${formatValue(opts)}` : ''
  const name = coll.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `db.getCollection('${name}').aggregate(${pipelineText(stages)}${optText})`
}
