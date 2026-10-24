import type { Doc } from './api'
import { isPlainDoc, shellText } from './bsonValue'
import type { ConvertTarget, ReschemaOp } from './maskingApi'

/**
 * Compiles Restructure Fields operations into update-pipeline stages (`$set` / `$unset` / `$replaceWith`) so the server
 * does the work. Writes to nested paths go through `$setField`, because a dotted `$set` would create (or
 * overwrite) parents even when there is nothing to write. Requires MongoDB 5.0+.
 */

export class ReschemaError extends Error {
  constructor(
    readonly op: number,
    message: string
  ) {
    super(message)
  }
}

/** Prefix of helper fields added by previews and dry runs. */
export const HELPER = '__mg_'
/** `onError` value used by dry runs to count failing conversions. */
export const CONVERT_FAILED = '__shardwise_conversion_failed__'

export const OP_LABELS: Record<ReschemaOp['kind'], string> = {
  rename: 'Rename / move field',
  remove: 'Remove field',
  default: 'Set default when missing',
  convert: 'Change type',
  split: 'Split string into array',
  merge: 'Merge fields',
  flatten: 'Flatten sub-document',
  nest: 'Nest prefixed fields',
  extract: 'Extract array element'
}

export const CONVERT_LABELS: Record<ConvertTarget, string> = {
  string: 'String',
  int: 'Int32',
  long: 'Int64 (Long)',
  double: 'Double',
  decimal: 'Decimal128',
  date: 'Date',
  objectId: 'ObjectId',
  bool: 'Boolean',
  array: 'Wrap in array',
  first: 'Array → first element'
}

const TRUE_WORDS = ['true', 'yes', 'y', '1', 'on', 't']
const FALSE_WORDS = ['false', 'no', 'n', '0', 'off', 'f', '']

const ref = (p: string): string => `$${p}`
const typeOf = (e: unknown): Doc => ({ $type: e })
const isMissing = (e: unknown): Doc => ({ $eq: [typeOf(e), 'missing'] })
const isType = (e: unknown, t: string): Doc => ({ $eq: [typeOf(e), t] })
const lit = (v: unknown): unknown => ({ $literal: v })

function checkPath(p: string | undefined, i: number, what: string, write: boolean): string {
  const path = (p ?? '').trim()
  if (!path) throw new ReschemaError(i, `${what}: enter a field path`)
  const segs = path.split('.')
  if (segs.some((s) => !s)) throw new ReschemaError(i, `${what}: "${path}" is not a valid field path`)
  if (segs.some((s) => s.startsWith('$'))) throw new ReschemaError(i, `${what}: field names cannot start with $`)
  if (write && segs[0] === '_id') throw new ReschemaError(i, `${what}: _id cannot be changed by an update`)
  if (segs[0].startsWith(HELPER)) throw new ReschemaError(i, `${what}: names starting with ${HELPER} are reserved`)
  return path
}

function checkName(n: string | undefined, i: number, what: string): string {
  const name = (n ?? '').trim()
  if (!name) throw new ReschemaError(i, `${what}: enter a field name`)
  if (name.includes('.') || name.startsWith('$')) throw new ReschemaError(i, `${what}: "${name}" must be a plain field name (no dots, no leading $)`)
  return name
}

const parentOf = (p: string): string => p.split('.').slice(0, -1).join('.')
const lastOf = (p: string): string => p.split('.').pop() ?? p

function setIn(cur: unknown, segs: string[]): Doc {
  const [k, ...rest] = segs
  const input = { $cond: [isType(cur, 'object'), cur, lit({})] }
  const value = rest.length ? setIn({ $getField: { field: k, input: cur } }, rest) : '$$v'
  return { $setField: { field: k, input, value } }
}

/**
 * `$set` entry writing `value` to `path`. A missing value leaves the field as it is (a top-level `$set` would
 * remove it, so callers pass the field's own reference when nothing should change). Nested writes leave the
 * document alone when a parent is neither a sub-document nor missing.
 */
export function assign(path: string, value: unknown): Doc {
  const segs = path.split('.')
  if (segs.length === 1) return { [path]: value }
  const top = segs[0]
  const guards: unknown[] = [isMissing('$$v')]
  for (let i = 1; i < segs.length; i++) guards.push({ $not: [{ $in: [typeOf(ref(segs.slice(0, i).join('.'))), ['object', 'missing']] }] })
  return { [top]: { $let: { vars: { v: value }, in: { $cond: [{ $or: guards }, ref(top), setIn(ref(top), segs.slice(1))] } } } }
}

const set = (path: string, value: unknown): Doc => ({ $set: assign(path, value) })

/** `DD/MM/YYYY`-style tokens → `$dateFromString` format; `%` formats pass through. */
export function mongoDateFormat(f: string): string {
  if (f.includes('%')) return f
  const tokens: [RegExp, string][] = [
    [/YYYY/g, '%Y'],
    [/MM/g, '%m'],
    [/DD/g, '%d'],
    [/HH/g, '%H'],
    [/mm/g, '%M'],
    [/ss/g, '%S'],
    [/SSS/g, '%L'],
    [/Z/g, '%z']
  ]
  // SSS before ss so milliseconds are not read as seconds.
  const order = [0, 1, 2, 3, 4, 6, 5, 7]
  let out = f
  for (const i of order) out = out.replace(tokens[i][0], tokens[i][1])
  return out
}

/** Conversion expression; `onError` is what failing values become. */
export function convertExpr(input: unknown, to: ConvertTarget, format: string | undefined, onError: unknown): unknown {
  switch (to) {
    case 'string':
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
    case 'objectId':
      return { $convert: { input, to, onError } }
    case 'date': {
      const plain = { $convert: { input, to: 'date', onError } }
      if (!format?.trim()) return plain
      return { $cond: [isType(input, 'string'), { $dateFromString: { dateString: input, format: mongoDateFormat(format.trim()), onError } }, plain] }
    }
    case 'bool': {
      const norm = { $toLower: { $trim: { input } } }
      return {
        $cond: [
          isType(input, 'string'),
          { $switch: { branches: [{ case: { $in: [norm, TRUE_WORDS] }, then: true }, { case: { $in: [norm, FALSE_WORDS] }, then: false }], default: onError } },
          { $convert: { input, to: 'bool', onError } }
        ]
      }
    }
    case 'array':
      return { $cond: [{ $isArray: input }, input, [input]] }
    case 'first':
      return { $cond: [{ $isArray: input }, { $cond: [{ $gt: [{ $size: input }, 0] }, { $arrayElemAt: [input, 0] }, null] }, input] }
  }
}

const canFail = (to: ConvertTarget): boolean => to !== 'array' && to !== 'first'

/** Leaves missing and null values alone. */
const guard = (p: string, expr: unknown): unknown => ({ $cond: [{ $in: [typeOf(ref(p)), ['missing', 'null']] }, ref(p), expr] })

/** Dry-run flag: the conversion of `op` fails for this document. Null for operations that cannot fail. */
export function failureExpr(op: ReschemaOp): unknown | null {
  if (op.kind !== 'convert' || !canFail(op.to)) return null
  const p = ref(op.path.trim())
  return { $and: [{ $not: [{ $in: [typeOf(p), ['missing', 'null']] }] }, { $eq: [convertExpr(p, op.to, op.format, CONVERT_FAILED), CONVERT_FAILED] }] }
}

/** Fields of `parentExpr` (a document) whose names start with `prefix`, excluding _id / helper fields when they would match. */
function prefixMatch(prefix: string, root: boolean): unknown {
  const conds: unknown[] = [{ $eq: [{ $indexOfCP: ['$$this.k', prefix] }, 0] }, { $gt: [{ $strLenCP: '$$this.k' }, [...prefix].length] }]
  if (root)
    for (const reserved of ['_id', HELPER]) if (reserved.startsWith(prefix) || prefix.startsWith(reserved)) conds.push({ $ne: [{ $indexOfCP: ['$$this.k', reserved] }, 0] })
  return { $and: conds }
}

/** Stages of one operation (`i` is its index, for error messages). */
export function compileOp(op: ReschemaOp, i = 0): Doc[] {
  switch (op.kind) {
    case 'rename': {
      const from = checkPath(op.from, i, 'Rename', true)
      const to = checkPath(op.to, i, 'New path', true)
      if (from === to) throw new ReschemaError(i, 'Rename: the new path is the same as the old one')
      if (to.startsWith(`${from}.`) || from.startsWith(`${to}.`)) {
        const tmp = `${HELPER}tmp`
        return [{ $set: { [tmp]: ref(from) } }, { $unset: from }, set(to, { $cond: [isMissing(ref(tmp)), ref(to), ref(tmp)] }), { $unset: tmp }]
      }
      return [set(to, { $cond: [isMissing(ref(from)), ref(to), ref(from)] }), { $unset: from }]
    }
    case 'remove':
      return [{ $unset: checkPath(op.path, i, 'Remove', true) }]
    case 'default': {
      const p = checkPath(op.path, i, 'Default', true)
      if (op.value === undefined) throw new ReschemaError(i, 'Default: enter a value')
      return [set(p, op.orNull ? { $ifNull: [ref(p), lit(op.value)] } : { $cond: [isMissing(ref(p)), lit(op.value), ref(p)] })]
    }
    case 'convert': {
      const p = checkPath(op.path, i, 'Change type', true)
      if (!CONVERT_LABELS[op.to]) throw new ReschemaError(i, 'Change type: choose a target type')
      const onError = op.onError === 'null' ? null : ref(p)
      return [set(p, guard(p, convertExpr(ref(p), op.to, op.format, onError)))]
    }
    case 'split': {
      const p = checkPath(op.path, i, 'Split', false)
      const to = op.to?.trim() ? checkPath(op.to, i, 'Split target', true) : checkPath(p, i, 'Split', true)
      if (!op.separator) throw new ReschemaError(i, 'Split: enter a separator')
      let parts: unknown = { $split: [ref(p), lit(op.separator)] }
      if (op.trim) parts = { $map: { input: parts, in: { $trim: { input: '$$this' } } } }
      if (op.dropEmpty) parts = { $filter: { input: parts, cond: { $ne: ['$$this', ''] } } }
      return [set(to, { $cond: [isType(ref(p), 'string'), parts, ref(to)] })]
    }
    case 'merge': {
      const paths = op.paths.map((x) => x.trim()).filter(Boolean)
      if (paths.length < 1) throw new ReschemaError(i, 'Merge: choose the fields to merge')
      paths.forEach((x) => checkPath(x, i, 'Merge', !!op.removeSources))
      const to = checkPath(op.to, i, 'Merge target', true)
      const parts = { $filter: { input: paths.map((x) => ({ $convert: { input: ref(x), to: 'string', onError: null, onNull: null } })), cond: { $ne: ['$$this', null] } } }
      const joined = { $reduce: { input: parts, initialValue: null, in: { $cond: [{ $eq: ['$$value', null] }, '$$this', { $concat: ['$$value', lit(op.separator ?? ''), '$$this'] }] } } }
      const stages: Doc[] = [set(to, { $ifNull: [joined, ref(to)] })]
      const drop = op.removeSources ? paths.filter((x) => x !== to) : []
      if (drop.length) stages.push({ $unset: drop.length === 1 ? drop[0] : drop })
      return stages
    }
    case 'flatten': {
      const p = checkPath(op.path, i, 'Flatten', true)
      const prefix = op.prefix ?? ''
      if (!prefix) throw new ReschemaError(i, 'Flatten: enter a prefix for the new field names')
      if (prefix.includes('.') || prefix.startsWith('$')) throw new ReschemaError(i, 'Flatten: the prefix cannot contain dots or start with $')
      const parent = parentOf(p)
      const name = lastOf(p)
      const src = ref(p)
      const mapped = { $arrayToObject: { $map: { input: { $objectToArray: src }, in: { k: { $concat: [lit(prefix), '$$this.k'] }, v: '$$this.v' } } } }
      if (!parent) return [{ $replaceWith: { $cond: [isType(src, 'object'), { $mergeObjects: [{ $unsetField: { field: name, input: '$$ROOT' } }, mapped] }, '$$ROOT'] } }]
      return [set(parent, { $cond: [isType(src, 'object'), { $mergeObjects: [{ $unsetField: { field: name, input: ref(parent) } }, mapped] }, ref(parent)] })]
    }
    case 'nest': {
      const prefix = op.prefix ?? ''
      if (!prefix) throw new ReschemaError(i, 'Nest: enter the prefix of the fields to nest')
      if (prefix.includes('.') || prefix.startsWith('$')) throw new ReschemaError(i, 'Nest: the prefix cannot contain dots or start with $')
      const to = checkName(op.to, i, 'Nest into')
      const parent = op.parent?.trim() ? checkPath(op.parent, i, 'Nest parent', true) : ''
      if (!parent && to === '_id') throw new ReschemaError(i, 'Nest: _id cannot be changed by an update')
      const doc = parent ? ref(parent) : '$$ROOT'
      const match = prefixMatch(prefix, !parent)
      const len = [...prefix].length
      const existing = { $getField: { field: to, input: '$$doc' } }
      const sub = {
        $mergeObjects: [
          { $cond: [isType(existing, 'object'), existing, lit({})] },
          { $arrayToObject: { $map: { input: '$$hit', in: { k: { $substrCP: ['$$this.k', len, { $subtract: [{ $strLenCP: '$$this.k' }, len] }] }, v: '$$this.v' } } } }
        ]
      }
      const rebuilt = {
        $let: {
          vars: { doc, kv: { $objectToArray: doc } },
          in: {
            $let: {
              vars: { hit: { $filter: { input: '$$kv', cond: match } } },
              in: { $cond: [{ $eq: [{ $size: '$$hit' }, 0] }, '$$doc', { $setField: { field: to, input: { $arrayToObject: { $filter: { input: '$$kv', cond: { $not: [match] } } } }, value: sub } }] }
            }
          }
        }
      }
      if (!parent) return [{ $replaceWith: rebuilt }]
      return [set(parent, { $cond: [isType(ref(parent), 'object'), rebuilt, ref(parent)] })]
    }
    case 'extract': {
      const p = checkPath(op.path, i, 'Extract', !!op.removeSource)
      const to = op.to?.trim() ? checkPath(op.to, i, 'Extract target', true) : checkPath(p, i, 'Extract', true)
      if (!Number.isInteger(op.index)) throw new ReschemaError(i, 'Extract: the index must be a whole number')
      const value = {
        $cond: [{ $isArray: ref(p) }, { $let: { vars: { e: { $arrayElemAt: [ref(p), op.index] } }, in: { $cond: [isMissing('$$e'), ref(to), '$$e'] } } }, ref(to)]
      }
      const stages: Doc[] = [set(to, value)]
      if (op.removeSource && to !== p) stages.push({ $unset: p })
      return stages
    }
  }
}

/** The update pipeline of all operations, in order. Throws ReschemaError naming the failing operation. */
export function compileOps(ops: readonly ReschemaOp[]): Doc[] {
  if (!ops.length) throw new ReschemaError(-1, 'Add at least one operation')
  return ops.flatMap((op, i) => compileOp(op, i))
}

/** Validate without throwing: the first problem, or null. */
export function reschemaProblem(ops: readonly ReschemaOp[]): { op: number; message: string } | null {
  try {
    compileOps(ops)
    return null
  } catch (e) {
    return { op: e instanceof ReschemaError ? e.op : -1, message: (e as Error).message }
  }
}

/** Aggregation previewing the first `limit` matching documents; each result carries the original in `__mg_orig`. */
export function previewPipeline(filter: Doc, ops: readonly ReschemaOp[], limit: number): Doc[] {
  return [{ $match: filter }, { $limit: Math.max(1, limit) }, { $set: { [`${HELPER}orig`]: '$$ROOT' } }, ...compileOps(ops)]
}

/** The document without helper fields. */
export function stripHelpers(doc: Doc): Doc {
  const out: Doc = {}
  for (const [k, v] of Object.entries(doc)) if (!k.startsWith(HELPER)) out[k] = v
  return out
}

/**
 * Dry run aggregation: per document, `__mg_changed` (content or a converted field's type differs) and
 * `__mg_f<i>` (conversion of operation i failed), computed with every earlier operation applied.
 */
export function dryRunStages(filter: Doc, ops: readonly ReschemaOp[]): Doc[] {
  const orig = `${HELPER}orig`
  const stages: Doc[] = [{ $match: filter }, { $set: { [orig]: '$$ROOT' } }]
  const typeFlags: string[] = []
  ops.forEach((op, i) => {
    const compiled = compileOp(op, i)
    const fail = failureExpr(op)
    if (op.kind === 'convert') {
      stages.push({ $set: { [`${HELPER}t${i}`]: typeOf(ref(op.path.trim())), ...(fail ? { [`${HELPER}f${i}`]: fail } : {}) } })
      stages.push(...compiled)
      stages.push({ $set: { [`${HELPER}t${i}`]: { $ne: [`$${HELPER}t${i}`, typeOf(ref(op.path.trim()))] } } })
      typeFlags.push(`$${HELPER}t${i}`)
    } else stages.push(...compiled)
  })
  const stripped = { $arrayToObject: { $filter: { input: { $objectToArray: '$$ROOT' }, cond: { $ne: [{ $indexOfCP: ['$$this.k', HELPER] }, 0] } } } }
  stages.push({ $set: { [`${HELPER}changed`]: { $or: [{ $ne: [`$${orig}`, stripped] }, ...typeFlags] } } })
  return stages
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const keyText = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k))

function flat(v: unknown): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(flat).join(', ')}]` : '[]'
  if (isPlainDoc(v)) {
    const e = Object.entries(v)
    return e.length ? `{ ${e.map(([k, x]) => `${keyText(k)}: ${flat(x)}`).join(', ')} }` : '{}'
  }
  return shellText(v)
}

/** Shell text that keeps short objects and arrays on one line. */
export function prettyShell(v: unknown, indent = '', width = 76): string {
  const one = flat(v)
  if (indent.length + one.length <= width || !(Array.isArray(v) || isPlainDoc(v))) return one
  const inner = `${indent}  `
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + prettyShell(x, inner, width)).join(',\n')}\n${indent}]`
  return `{\n${Object.entries(v)
    .map(([k, x]) => `${inner}${keyText(k)}: ${prettyShell(x, inner, width)}`)
    .join(',\n')}\n${indent}}`
}

/** Field name usable as `db.<name>` in the shell. */
const shellIdent = (s: string): boolean => /^[A-Za-z_$][\w$]*$/.test(s) && !['getCollection', 'getName', 'runCommand', 'aggregate'].includes(s)

/** `db.coll.updateMany(filter, [pipeline])` in shell syntax. */
export function reschemaCommand(coll: string, filter: Doc, pipeline: Doc[]): string {
  const target = shellIdent(coll) ? `db.${coll}` : `db.getCollection(${quote(coll)})`
  return `${target}.updateMany(\n  ${prettyShell(filter, '  ')},\n  ${prettyShell(pipeline, '  ')}\n)`
}
