import { bsonTypeOf, isPlainDoc, TYPE_LABELS } from './bsonValue'
import { SQL_RESERVED } from './sqlToMongo'

type Doc = Record<string, unknown>

export type MongoQueryShape =
  | { coll: string; filter?: Doc | null; projection?: Doc | null; sort?: Doc | null; skip?: number; limit?: number }
  | { coll: string; pipeline: Doc[] }

export type MongoToSqlResult = { sql: string; reason?: undefined } | { sql: null; reason: string }

class NoSql extends Error {}
const no = (reason: string): never => {
  throw new NoSql(reason)
}

/** A name as a SQL identifier, quoted with backticks when needed. */
export function sqlIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SQL_RESERVED.has(name.toUpperCase()) ? name : `\`${name.replace(/`/g, '``')}\``
}

function collSql(name: string): string {
  const parts = name.split('.')
  return parts.every((p) => sqlIdent(p) === p) ? name : sqlIdent(name)
}

function lit(v: unknown): string {
  const t = bsonTypeOf(v)
  switch (t) {
    case 'null':
      return 'NULL'
    case 'string':
      return `'${(v as string).replace(/'/g, "''")}'`
    case 'bool':
      return v ? 'TRUE' : 'FALSE'
    case 'int':
    case 'double':
    case 'long':
    case 'decimal': {
      const s = String(typeof v === 'object' ? (v as { toString(): string }).toString() : v)
      if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) no(`The number ${s} has no SQL literal`)
      return s
    }
    case 'date': {
      const d = v as Date
      if (isNaN(d.getTime())) no('Invalid dates have no SQL literal')
      return `ISODate('${d.toISOString()}')`
    }
    case 'objectId':
      return `ObjectId('${(v as { toHexString(): string }).toHexString()}')`
  }
  return no(`${TYPE_LABELS[t]} values have no SQL literal`)
}

/** Regular expression → LIKE pattern, or null when it uses real regex features. */
export function regexToLike(source: string): string | null {
  let s = source
  let start = false
  let end = false
  if (s.startsWith('^')) {
    start = true
    s = s.slice(1)
  }
  if (/(^|[^\\])(\\\\)*\$$/.test(s)) {
    end = true
    s = s.slice(0, -1)
  }
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      const n = s[++i]
      if (n === undefined || /[A-Za-z0-9]/.test(n)) return null
      out += n === '%' || n === '_' || n === '\\' ? `\\${n}` : n
    } else if (c === '.' && s[i + 1] === '*') {
      out += '%'
      i++
    } else if (c === '.') out += '_'
    else if ('[](){}+?*|^$'.includes(c)) return null
    else out += c === '%' || c === '_' ? `\\${c}` : c
  }
  let like = (start ? '' : '%') + out + (end ? '' : '%')
  while (like.startsWith('%%')) like = like.slice(1)
  while (like.endsWith('%%') && like[like.length - 3] !== '\\') like = like.slice(0, -1)
  return like
}

interface Cond {
  sql: string
  /** 0 = OR, 1 = AND, 2 = atom */
  prec: number
}
const atom = (sql: string): Cond => ({ sql, prec: 2 })
const andOf = (cs: Cond[]): Cond => (cs.length === 1 ? cs[0] : { sql: cs.map((c) => (c.prec === 0 ? `(${c.sql})` : c.sql)).join(' AND '), prec: 1 })
const orOf = (cs: Cond[]): Cond => (cs.length === 1 ? cs[0] : { sql: cs.map((c) => c.sql).join(' OR '), prec: 0 })
const notOf = (c: Cond): Cond => atom(`NOT (${c.sql})`)

type FieldFn = (path: string) => string

const CMP: Record<string, string> = { $eq: '=', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }
const isOpDoc = (v: unknown): v is Doc => isPlainDoc(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'))

function likeCond(f: string, source: string, options: string, negate: boolean): Cond {
  if (options && options !== 'i') no(`Regex options '${options}' have no SQL equivalent`)
  const like = regexToLike(source)
  if (like === null) no(`The regular expression /${source}/ cannot be written as LIKE`)
  return atom(`${f} ${negate ? 'NOT ' : ''}${options === 'i' ? 'ILIKE' : 'LIKE'} ${lit(like)}`)
}

function regexParts(v: unknown): { source: string; options: string } {
  if (v instanceof RegExp) return { source: v.source, options: v.flags }
  const r = v as { pattern: string; options: string }
  return { source: r.pattern, options: r.options }
}

const list = (v: unknown, op: string): string => {
  if (!Array.isArray(v)) return no(`${op} needs an array`)
  return v.map(lit).join(', ')
}

function fieldCond(f: string, v: unknown): Cond {
  if (isOpDoc(v)) {
    const conds: Cond[] = []
    const ops = { ...v }
    if ('$gte' in ops && '$lte' in ops) {
      conds.push(atom(`${f} BETWEEN ${lit(ops.$gte)} AND ${lit(ops.$lte)}`))
      delete ops.$gte
      delete ops.$lte
    }
    for (const [op, x] of Object.entries(ops)) {
      switch (op) {
        case '$eq':
        case '$ne':
          conds.push(atom(x === null ? `${f} IS ${op === '$ne' ? 'NOT ' : ''}NULL` : `${f} ${CMP[op]} ${lit(x)}`))
          break
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          conds.push(atom(`${f} ${CMP[op]} ${lit(x)}`))
          break
        case '$in':
          conds.push(atom(`${f} IN (${list(x, op)})`))
          break
        case '$nin':
          conds.push(atom(`${f} NOT IN (${list(x, op)})`))
          break
        case '$exists':
          conds.push(atom(`${f} IS ${x ? 'NOT ' : ''}NULL`))
          break
        case '$regex': {
          const r = typeof x === 'string' ? { source: x, options: '' } : regexParts(x)
          conds.push(likeCond(f, r.source, typeof ops.$options === 'string' ? ops.$options : r.options, false))
          break
        }
        case '$options':
          if (!('$regex' in ops)) no('$options without $regex')
          break
        case '$not':
          if (bsonTypeOf(x) === 'regex') {
            const r = regexParts(x)
            conds.push(likeCond(f, r.source, r.options, true))
          } else if (isOpDoc(x) && typeof x.$regex === 'string') {
            conds.push(likeCond(f, x.$regex, typeof x.$options === 'string' ? x.$options : '', true))
          } else if (isOpDoc(x)) conds.push(notOf(fieldCond(f, x)))
          else no('$not needs an operator document')
          break
        default:
          no(`${op} has no SQL equivalent`)
      }
    }
    return andOf(conds)
  }
  const t = bsonTypeOf(v)
  if (t === 'regex') {
    const r = regexParts(v)
    return likeCond(f, r.source, r.options, false)
  }
  if (t === 'null') return atom(`${f} IS NULL`)
  if (t === 'array' || t === 'object') no('Matching a whole array or embedded document has no SQL equivalent')
  return atom(`${f} = ${lit(v)}`)
}

function exprOperand(x: unknown, field: FieldFn): string {
  if (typeof x === 'string' && x.startsWith('$')) {
    if (x.startsWith('$$')) no(`Variable ${x} has no SQL equivalent`)
    return field(x.slice(1))
  }
  if (isPlainDoc(x)) no('This $expr has no SQL equivalent')
  return lit(x)
}

function exprCond(e: unknown, field: FieldFn): Cond {
  if (isPlainDoc(e) && Object.keys(e).length === 1) {
    const [op, args] = Object.entries(e)[0]
    if (CMP[op] && Array.isArray(args) && args.length === 2) return atom(`${exprOperand(args[0], field)} ${CMP[op]} ${exprOperand(args[1], field)}`)
    if ((op === '$and' || op === '$or') && Array.isArray(args) && args.length) {
      const cs = args.map((a) => exprCond(a, field))
      return op === '$and' ? andOf(cs) : orOf(cs)
    }
    if (op === '$not' && Array.isArray(args) && args.length === 1) return notOf(exprCond(args[0], field))
  }
  return no('This $expr has no SQL equivalent')
}

function whereOf(filter: Doc, field: FieldFn): Cond | null {
  const cs: Cond[] = []
  const sub = (v: unknown, op: string): Cond[] => {
    if (!Array.isArray(v) || !v.length) no(`${op} needs a non-empty array`)
    return (v as Doc[]).map((x) => whereOf(x, field) ?? atom('TRUE'))
  }
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and') cs.push(andOf(sub(v, k)))
    else if (k === '$or') cs.push(orOf(sub(v, k)))
    else if (k === '$nor') cs.push(notOf(orOf(sub(v, k))))
    else if (k === '$expr') cs.push(exprCond(v, field))
    else if (k === '$comment') continue
    else if (k.startsWith('$')) no(`${k} has no SQL equivalent`)
    else cs.push(fieldCond(field(k), v))
  }
  return cs.length ? andOf(cs) : null
}

const asNumber = (v: unknown): number | null => {
  const t = bsonTypeOf(v)
  if (t === 'bool') return v ? 1 : 0
  if (t === 'int' || t === 'double' || t === 'long') return Number(String(v))
  return null
}

const sortSql = (sort: Doc, field: FieldFn): string =>
  Object.entries(sort)
    .map(([k, v]) => {
      const n = asNumber(v)
      if (n !== 1 && n !== -1) no(`Sorting by ${JSON.stringify(v)} has no SQL equivalent`)
      return `${field(k)}${n === -1 ? ' DESC' : ''}`
    })
    .join(', ')

const fieldPath = (coll: string): FieldFn => (path) => {
  const parts = path.split('.')
  const sql = parts.map(sqlIdent).join('.')
  // Keep a first segment that matches the collection name from being read as a table qualifier.
  return parts.length > 1 && parts[0].toLowerCase() === coll.toLowerCase() ? `${collSql(coll)}.${sql}` : sql
}

const aliased = (expr: string, name: string): string => (expr === sqlIdent(name) || expr === name ? expr : `${expr} AS ${sqlIdent(name)}`)

function projectionCols(p: Doc, field: FieldFn): string[] | null {
  const keys = Object.keys(p)
  if (!keys.length) return null
  let withId = true
  const cols: string[] = []
  for (const [k, v] of Object.entries(p)) {
    const n = asNumber(v)
    if (n === 0) {
      if (k === '_id') withId = false
      else no("Exclusion projections can't be written as SQL; list the columns to include")
    } else if (n !== null) cols.push(field(k))
    else if (typeof v === 'string' && v.startsWith('$') && !v.startsWith('$$')) cols.push(aliased(field(v.slice(1)), k))
    else no(`The projection of '${k}' has no SQL equivalent`)
  }
  if (!cols.length) no("Exclusion projections can't be written as SQL; list the columns to include")
  if (withId && !keys.includes('_id')) cols.unshift(field('_id'))
  return cols
}

function assemble(p: { select: string[] | null; coll: string; where?: Cond | null; groupBy?: string[]; having?: Cond | null; order?: string; skip?: number; limit?: number }): string {
  const lines = [`SELECT ${p.select?.join(', ') ?? '*'}`, `FROM ${collSql(p.coll)}`]
  if (p.where) lines.push(`WHERE ${p.where.sql}`)
  if (p.groupBy?.length) lines.push(`GROUP BY ${p.groupBy.join(', ')}`)
  if (p.having) lines.push(`HAVING ${p.having.sql}`)
  if (p.order) lines.push(`ORDER BY ${p.order}`)
  const page: string[] = []
  if (p.limit !== undefined && p.limit > 0) page.push(`LIMIT ${p.limit}`)
  if (p.skip) page.push(`OFFSET ${p.skip}`)
  if (page.length) lines.push(page.join(' '))
  return lines.join('\n')
}

const ACC_FN: Record<string, string> = { $sum: 'SUM', $avg: 'AVG', $min: 'MIN', $max: 'MAX' }

function pipelineSql(coll: string, pipeline: Doc[]): string {
  const field = fieldPath(coll)
  const where: Cond[] = []
  const having: Cond[] = []
  let group: { keys: { name: string; sql: string }[]; scalar?: string; accs: Map<string, string> } | null = null
  let select: string[] | null = null
  let order: string | undefined
  let skip = 0
  let limit: number | undefined
  let projected = false
  let sorted = false
  let counted = false

  const groupField: FieldFn = (path) => {
    if (!group) return field(path)
    if (path === '_id' && group.scalar) return group.scalar
    const key = path.startsWith('_id.') && group.keys.find((k) => k.name === path.slice(4))
    if (key) return key.sql
    const acc = group.accs.get(path)
    if (acc) return acc
    return no(`'${path}' is not an output of $group`)
  }

  for (const stage of pipeline) {
    const keys = Object.keys(stage)
    if (keys.length !== 1) no('Each pipeline stage needs exactly one operator')
    const op = keys[0]
    const body = stage[op]
    if (counted) no(`${op} after $count has no SQL equivalent`)
    const paged = skip > 0 || limit !== undefined
    switch (op) {
      case '$match': {
        if (!isPlainDoc(body)) no('$match needs a document')
        if (projected || sorted || paged) no(`A $match after $project, $sort, $skip or $limit can't be written as one SELECT`)
        const c = whereOf(body as Doc, group ? groupField : field)
        if (c) (group ? having : where).push(c)
        break
      }
      case '$group': {
        if (group || projected || sorted || paged) no('$group must come before $project, $sort, $skip and $limit, and only once')
        const g = body as Doc
        const id = g._id
        const keysOut: { name: string; sql: string }[] = []
        let scalar: string | undefined
        if (typeof id === 'string' && id.startsWith('$')) scalar = field(id.slice(1))
        else if (isPlainDoc(id)) {
          for (const [k, v] of Object.entries(id)) {
            if (typeof v !== 'string' || !v.startsWith('$') || v.startsWith('$$')) no('Group keys must be field paths')
            keysOut.push({ name: k, sql: field((v as string).slice(1)) })
          }
        } else if (Array.isArray(id)) no('Group keys must be field paths')
        const accs = new Map<string, string>()
        for (const [name, spec] of Object.entries(g)) {
          if (name === '_id') continue
          if (!isPlainDoc(spec) || Object.keys(spec).length !== 1) no(`Accumulator '${name}' has no SQL equivalent`)
          const [acc, arg] = Object.entries(spec as Doc)[0]
          if ((acc === '$sum' && asNumber(arg) === 1) || (acc === '$count' && isPlainDoc(arg))) accs.set(name, 'COUNT(*)')
          else if (ACC_FN[acc] && typeof arg === 'string' && arg.startsWith('$') && !arg.startsWith('$$')) accs.set(name, `${ACC_FN[acc]}(${field(arg.slice(1))})`)
          else no(`Accumulator ${acc} in '${name}' has no SQL equivalent`)
        }
        group = { keys: keysOut, scalar, accs }
        break
      }
      case '$count': {
        if (group || projected || typeof body !== 'string') no('$count can only follow $match stages')
        select = [aliased('COUNT(*)', body as string)]
        counted = true
        break
      }
      case '$project': {
        if (projected) no('Only one $project stage can be written as SQL')
        if (!isPlainDoc(body)) no('$project needs a document')
        if (group) {
          const cols: string[] = []
          for (const [k, v] of Object.entries(body as Doc)) {
            const n = asNumber(v)
            if (n === 0 && k === '_id') continue
            if (n === 1) cols.push(aliased(groupField(k), k))
            else if (typeof v === 'string' && v.startsWith('$') && !v.startsWith('$$')) cols.push(aliased(groupField(v.slice(1)), k))
            else no(`The projection of '${k}' has no SQL equivalent`)
          }
          select = cols
        } else select = projectionCols(body as Doc, field)
        projected = true
        break
      }
      case '$sort': {
        if (sorted || paged) no('$sort after $skip or $limit has no SQL equivalent')
        if (!isPlainDoc(body)) no('$sort needs a document')
        order = sortSql(body as Doc, projected ? (p) => sqlIdent(p) : group ? groupField : field)
        sorted = true
        break
      }
      case '$skip': {
        const n = asNumber(body)
        if (n === null || n < 0) no('$skip needs a number')
        if (limit !== undefined) no('$skip after $limit has no SQL equivalent')
        skip += n!
        break
      }
      case '$limit': {
        const n = asNumber(body)
        if (n === null || n < 1) no('$limit needs a positive number')
        limit = limit === undefined ? n! : Math.min(limit, n!)
        break
      }
      default:
        no(`${op} has no SQL equivalent`)
    }
  }

  if (group && !select) {
    const g = group as NonNullable<typeof group>
    select = [...(g.scalar ? [aliased(g.scalar, '_id')] : []), ...g.keys.map((k) => aliased(k.sql, k.name)), ...[...g.accs].map(([name, sql]) => aliased(sql, name))]
  }
  const g = group as typeof group
  return assemble({
    select,
    coll,
    where: where.length ? andOf(where) : null,
    groupBy: g ? [...(g.scalar ? [g.scalar] : []), ...g.keys.map((k) => k.sql)] : [],
    having: having.length ? andOf(having) : null,
    order,
    skip,
    limit
  })
}

/** Best-effort SQL for a find query or a simple pipeline; `sql: null` with a reason when it has no SQL equivalent. */
export function mongoToSql(q: MongoQueryShape): MongoToSqlResult {
  try {
    if ('pipeline' in q) return { sql: pipelineSql(q.coll, q.pipeline) }
    const field = fieldPath(q.coll)
    return {
      sql: assemble({
        select: q.projection ? projectionCols(q.projection, field) : null,
        coll: q.coll,
        where: q.filter ? whereOf(q.filter, field) : null,
        order: q.sort && Object.keys(q.sort).length ? sortSql(q.sort, field) : undefined,
        skip: q.skip,
        limit: q.limit
      })
    }
  } catch (e) {
    if (e instanceof NoSql) return { sql: null, reason: e.message }
    throw e
  }
}
