import {
  BSONRegExp,
  Double,
  Int32,
  ValueParseError,
  bsonTypeOf,
  editText,
  isEditableType,
  isPlainDoc,
  parseTyped
} from '../bsonValue'
import { STRING_MATCH_OPS } from './operators'
import { newGroup, newRule, VqbValueError } from './types'
import type { Group, GroupOp, Node, OperatorId, Rule } from './types'

type Doc = Record<string, unknown>

// ---------------------------------------------------------------------------
// Builder model -> filter document
// ---------------------------------------------------------------------------

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Query values do not need Int32/Double wrappers; plain numbers keep the query text readable. */
function queryValue(v: unknown): unknown {
  const t = (v as { _bsontype?: string } | null)?._bsontype
  if (t === 'Int32') return (v as Int32).value
  if (t === 'Double' && !Number.isInteger((v as Double).value)) return (v as Double).value
  if (t === 'BSONRegExp' && v instanceof BSONRegExp) {
    try {
      return new RegExp(v.pattern, v.options)
    } catch {
      return v
    }
  }
  return v
}

function parseRuleValue(r: Rule, text: string): unknown {
  try {
    return queryValue(parseTyped(text, r.valueType))
  } catch (e) {
    if (e instanceof ValueParseError) throw new VqbValueError(`${r.field || 'value'}: ${e.message}`, r.id)
    throw e
  }
}

function listValues(r: Rule): unknown[] {
  // One value per line; non-string types may also be separated by commas.
  let lines = r.valueType === 'string' ? r.value.split('\n') : r.value.split(/[\n,]/)
  if (r.valueType !== 'string') lines = lines.filter((l) => l.trim() !== '')
  else if (lines.length > 1 && lines[lines.length - 1] === '') lines = lines.slice(0, -1)
  if (r.value === '') lines = []
  return lines.map((l) => parseRuleValue(r, l))
}

function regexCond(r: Rule): Doc {
  const lit = escapeRegex(r.value)
  const pattern = r.op.toLowerCase().includes('starts') ? `^${lit}` : r.op.toLowerCase().includes('ends') ? `${lit}$` : lit
  const cond: Doc = { $regex: pattern }
  if (r.caseInsensitive) cond.$options = 'i'
  return r.op.startsWith('not') ? { $not: cond } : cond
}

const RANGE_KEYS: Partial<Record<OperatorId, [string, string]>> = {
  range_gt_lt: ['$gt', '$lt'],
  range_gt_lte: ['$gt', '$lte'],
  range_gte_lt: ['$gte', '$lt'],
  range_gte_lte: ['$gte', '$lte']
}

/** The condition part of a rule, e.g. `{ $gt: 5 }` or a literal for equality. */
function ruleCond(r: Rule): unknown {
  const v = (): unknown => parseRuleValue(r, r.value)
  const range = RANGE_KEYS[r.op]
  if (range) return { [range[0]]: v(), [range[1]]: parseRuleValue(r, r.value2) }
  if (STRING_MATCH_OPS.includes(r.op)) return regexCond(r)
  switch (r.op) {
    case 'eq':
      return v()
    case 'ne':
      return { $ne: v() }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { [`$${r.op}`]: v() }
    case 'in':
    case 'nin':
    case 'all':
      return { [`$${r.op}`]: listValues(r) }
    case 'exists':
      return { $exists: true }
    case 'notExists':
      return { $exists: false }
    case 'isNull':
      return null
    case 'notNull':
      return { $ne: null }
    case 'type':
      return { $type: typeAlias(r.value) }
    case 'notType':
      return { $not: { $type: typeAlias(r.value) } }
  }
  throw new VqbValueError(`Unsupported operator ${r.op}`, r.id)
}

const typeAlias = (s: string): string | number => (/^\d+$/.test(s.trim()) ? Number(s) : s.trim())

function textFilter(r: Rule): Doc {
  const t: Doc = { $search: r.value }
  if (r.textLanguage) t.$language = r.textLanguage
  if (r.textCaseSensitive) t.$caseSensitive = true
  if (r.textDiacriticSensitive) t.$diacriticSensitive = true
  return { $text: t }
}

const isOpDoc = (v: unknown): v is Doc =>
  isPlainDoc(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'))

/** AND-combine filters into one object where possible, else `$and`. */
function mergeAnd(filters: Doc[]): Doc {
  if (filters.length === 0) return {}
  if (filters.length === 1) return filters[0]
  const out: Doc = {}
  for (const f of filters) {
    for (const [k, v] of Object.entries(f)) {
      if (!(k in out)) {
        out[k] = isOpDoc(v) ? { ...v } : v
        continue
      }
      const prev = out[k]
      if (isOpDoc(prev) && isOpDoc(v) && !Object.keys(v).some((op) => op in prev)) {
        Object.assign(prev, v)
        continue
      }
      return { $and: filters }
    }
  }
  return out
}

/** A rule inside $elemMatch with an empty field applies to the element itself. */
function elementCond(r: Rule): Doc {
  const c = ruleCond(r)
  return isOpDoc(c) ? c : { $eq: c }
}

function nodeFilter(n: Node, inElemMatch: boolean): Doc | null {
  if (!n.enabled) return null
  if (n.kind === 'rule') {
    if (n.op === 'text') return textFilter(n)
    if (!n.field) {
      if (inElemMatch) return elementCond(n)
      throw new VqbValueError('Field name is missing', n.id)
    }
    return { [n.field]: ruleCond(n) }
  }
  return groupFilter(n)
}

function groupFilter(g: Group): Doc | null {
  const elem = g.op === 'elemMatch' || g.op === 'notElemMatch'
  const parts = g.children
    .map((c) => nodeFilter(c, elem))
    .filter((f): f is Doc => f !== null && Object.keys(f).length > 0)
  switch (g.op) {
    case 'and':
      return parts.length ? mergeAnd(parts) : null
    case 'or':
    case 'nor':
      return parts.length ? { [`$${g.op}`]: parts } : null
    case 'elemMatch':
    case 'notElemMatch': {
      if (!g.field) throw new VqbValueError('Array field name is missing', g.id)
      const em = { $elemMatch: mergeAnd(parts) }
      return { [g.field]: g.op === 'elemMatch' ? em : { $not: em } }
    }
  }
}

/** Convert a builder tree to a MongoDB filter. Throws VqbValueError for invalid values. */
export function groupToFilter(root: Group): Doc {
  return groupFilter({ ...root, enabled: true }) ?? {}
}

// ---------------------------------------------------------------------------
// Filter document -> builder model (null when not representable)
// ---------------------------------------------------------------------------

const REGEX_META = '.*+?^${}()|[]\\/'

/** Unescape a regex that only contains literal characters; null if it uses regex syntax. */
function regexLiteral(p: string): string | null {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\') {
      const nx = p[i + 1]
      if (nx === undefined || !REGEX_META.includes(nx)) return null
      out += nx
      i++
    } else if (REGEX_META.includes(c)) {
      return null
    } else out += c
  }
  return out
}

function regexRule(field: string, pattern: string, options: string, negate: boolean): Rule | null {
  if (options === '' || options === 'i') {
    const starts = pattern.startsWith('^')
    const ends = pattern.endsWith('$') && !pattern.endsWith('\\$')
    if (!(starts && ends)) {
      const core = pattern.slice(starts ? 1 : 0, ends ? -1 : undefined)
      const lit = regexLiteral(core)
      if (lit !== null) {
        const base = starts ? 'startsWith' : ends ? 'endsWith' : 'contains'
        const op = (negate ? `not${base[0].toUpperCase()}${base.slice(1)}` : base) as OperatorId
        return { ...newRule(field), op, value: lit, caseInsensitive: options === 'i' }
      }
    }
  }
  if (negate) return null
  return { ...newRule(field), op: 'eq', valueType: 'regex', value: `/${pattern}/${options}` }
}

function regexParts(v: unknown): [string, string] | null {
  if (v instanceof RegExp || Object.prototype.toString.call(v) === '[object RegExp]') {
    const r = v as RegExp
    return [r.source, r.flags]
  }
  if ((v as { _bsontype?: string } | null)?._bsontype === 'BSONRegExp') {
    const r = v as BSONRegExp
    return [r.pattern, r.options]
  }
  return null
}

function typedRule(field: string, op: OperatorId, v: unknown): Rule | null {
  const t = bsonTypeOf(v)
  if (!isEditableType(t)) return null
  if (t === 'regex') {
    if (op !== 'eq') return null
    const [p, o] = regexParts(v)!
    return regexRule(field, p, o, false)
  }
  return { ...newRule(field), op, valueType: t, value: editText(v) }
}

function listRule(field: string, op: OperatorId, v: unknown): Rule | null {
  if (!Array.isArray(v)) return null
  if (v.length === 0) return { ...newRule(field), op }
  const types = new Set(v.map(bsonTypeOf))
  if (types.size !== 1) return null
  const t = [...types][0]
  if (!isEditableType(t) || t === 'array' || t === 'object' || t === 'regex' || t === 'null') return null
  const texts = v.map(editText)
  // Empty entries and line breaks cannot be represented one per line without changing the list.
  if (texts.some((s) => s === '' || s.includes('\n'))) return null
  return { ...newRule(field), op, valueType: t, value: texts.join('\n') }
}

function textRule(v: unknown): Rule | null {
  if (!isPlainDoc(v) || typeof v.$search !== 'string') return null
  const allowed = ['$search', '$language', '$caseSensitive', '$diacriticSensitive']
  if (Object.keys(v).some((k) => !allowed.includes(k))) return null
  return {
    ...newRule(),
    op: 'text',
    value: v.$search,
    textLanguage: typeof v.$language === 'string' ? v.$language : undefined,
    textCaseSensitive: v.$caseSensitive === true || undefined,
    textDiacriticSensitive: v.$diacriticSensitive === true || undefined
  }
}

function parseNot(field: string, v: unknown): Node | null {
  const rp = regexParts(v)
  if (rp) return regexRule(field, rp[0], rp[1], true)
  if (!isPlainDoc(v)) return null
  const keys = Object.keys(v)
  if (keys.includes('$regex') && keys.every((k) => k === '$regex' || k === '$options')) {
    const inner = regexParts(v.$regex)
    const pattern = inner ? inner[0] : v.$regex
    if (typeof pattern !== 'string') return null
    const options = String(v.$options ?? (inner ? inner[1] : ''))
    return regexRule(field, pattern, options, true)
  }
  if (keys.length === 1 && keys[0] === '$type') return { ...newRule(field), op: 'notType', value: String(v.$type) }
  if (keys.length === 1 && keys[0] === '$elemMatch' && isPlainDoc(v.$elemMatch)) {
    const children = parseDoc(v.$elemMatch, true)
    return children && { ...newGroup('notElemMatch', field), children }
  }
  return null
}

function parseOps(field: string, ops: Doc): Node[] | null {
  const o = { ...ops }
  const nodes: Node[] = []
  if ('$regex' in o) {
    const inner = regexParts(o.$regex)
    const pattern = inner ? inner[0] : o.$regex
    if (typeof pattern !== 'string') return null
    const options = String(o.$options ?? (inner ? inner[1] : ''))
    delete o.$regex
    delete o.$options
    const r = regexRule(field, pattern, options, false)
    if (!r) return null
    nodes.push(r)
  } else if ('$options' in o) return null

  const lowK = '$gt' in o ? '$gt' : '$gte' in o ? '$gte' : null
  const highK = '$lt' in o ? '$lt' : '$lte' in o ? '$lte' : null
  if (lowK && highK) {
    const lo = o[lowK]
    const hi = o[highK]
    const t = bsonTypeOf(lo)
    if (t === bsonTypeOf(hi) && isEditableType(t) && !['array', 'object', 'null', 'regex', 'bool'].includes(t)) {
      const op = `range_${lowK.slice(1)}_${highK.slice(1)}` as OperatorId
      nodes.push({ ...newRule(field), op, valueType: t, value: editText(lo), value2: editText(hi) })
      delete o[lowK]
      delete o[highK]
    }
  }

  for (const [k, v] of Object.entries(o)) {
    let n: Node | null = null
    switch (k) {
      case '$eq':
        // { $eq: /re/ } matches the stored regex itself, unlike a bare /re/ which pattern-matches.
        n = v === null ? { ...newRule(field), op: 'isNull' } : bsonTypeOf(v) === 'regex' ? null : typedRule(field, 'eq', v)
        break
      case '$ne':
        n = v === null ? { ...newRule(field), op: 'notNull' } : typedRule(field, 'ne', v)
        break
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte':
        n = typedRule(field, k.slice(1) as OperatorId, v)
        break
      case '$in':
      case '$nin':
      case '$all':
        n = listRule(field, k.slice(1) as OperatorId, v)
        break
      case '$exists':
        n = { ...newRule(field), op: v && v.valueOf() ? 'exists' : 'notExists' }
        break
      case '$type':
        if (typeof v === 'string' || typeof v === 'number') n = { ...newRule(field), op: 'type', value: String(v) }
        break
      case '$not':
        n = parseNot(field, v)
        break
      case '$elemMatch':
        if (isPlainDoc(v)) {
          const children = parseDoc(v, true)
          n = children && { ...newGroup('elemMatch', field), children }
        }
        break
    }
    if (!n) return null
    nodes.push(n)
  }
  return nodes
}

function parseField(field: string, v: unknown): Node[] | null {
  if (isOpDoc(v)) return parseOps(field, v)
  if (v === null) return [{ ...newRule(field), op: 'isNull' }]
  const r = typedRule(field, 'eq', v)
  return r && [r]
}

function parseLogical(op: GroupOp, v: unknown): Group | null {
  if (!Array.isArray(v)) return null
  const g = newGroup(op)
  for (const el of v) {
    if (!isPlainDoc(el)) return null
    const sub = parseDoc(el, false)
    // An empty branch matches everything; dropping it would change the query.
    if (!sub || !sub.length) return null
    g.children.push(sub.length === 1 ? sub[0] : { ...newGroup('and'), children: sub })
  }
  return g
}

const LOGICAL = ['$and', '$or', '$nor']

/** Parse the conditions of an AND-ed document into builder nodes. */
function parseDoc(doc: Doc, inElemMatch: boolean): Node[] | null {
  const keys = Object.keys(doc)
  if (inElemMatch && keys.length > 0 && keys.every((k) => k.startsWith('$') && !LOGICAL.includes(k))) {
    return parseOps('', doc)
  }
  const nodes: Node[] = []
  for (const [k, v] of Object.entries(doc)) {
    if (k === '$and') {
      if (!Array.isArray(v)) return null
      for (const el of v) {
        if (!isPlainDoc(el)) return null
        const sub = parseDoc(el, inElemMatch)
        if (!sub) return null
        nodes.push(...sub)
      }
    } else if (k === '$or' || k === '$nor') {
      const g = parseLogical(k.slice(1) as GroupOp, v)
      if (!g) return null
      nodes.push(g)
    } else if (k === '$text') {
      const r = textRule(v)
      if (!r) return null
      nodes.push(r)
    } else if (k.startsWith('$')) {
      return null
    } else {
      const sub = parseField(k, v)
      if (!sub) return null
      nodes.push(...sub)
    }
  }
  return nodes
}

/** Convert a filter to a builder tree, or null when the builder cannot represent it. */
export function filterToGroup(filter: unknown): Group | null {
  if (filter == null) return newGroup('and')
  if (!isPlainDoc(filter)) return null
  const keys = Object.keys(filter)
  if (keys.length === 1 && (keys[0] === '$or' || keys[0] === '$nor')) {
    return parseLogical(keys[0].slice(1) as GroupOp, filter[keys[0]])
  }
  const children = parseDoc(filter, false)
  return children && { ...newGroup('and'), children }
}
