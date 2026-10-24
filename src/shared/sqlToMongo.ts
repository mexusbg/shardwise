import { ObjectId } from 'bson'
import { parseUtcDate } from './bsonValue'

type Doc = Record<string, unknown>

export type SqlFind = { coll: string; kind: 'find'; filter: Doc; projection: Doc | null; sort: Doc | null; skip: number; limit: number }
export type SqlAggregate = { coll: string; kind: 'aggregate'; pipeline: Doc[] }
export type SqlTranslation = SqlFind | SqlAggregate

/** A parse or translation error; `pos`/`end` are offsets into the SQL text. */
export class SqlError extends Error {
  pos: number
  end: number
  constructor(message: string, pos: number, end = pos) {
    super(message)
    this.name = 'SqlError'
    this.pos = pos
    this.end = Math.max(end, pos)
  }
}

/** 1-based line / column of an offset. */
export function sqlPosition(sql: string, pos: number): { line: number; col: number } {
  const lines = sql.slice(0, pos).split('\n')
  return { line: lines.length, col: lines[lines.length - 1].length + 1 }
}

// ---------------------------------------------------------------------------
// Tokenizer

type TokKind = 'word' | 'quoted' | 'string' | 'number' | 'op' | 'eof'
interface Tok {
  kind: TokKind
  text: string
  raw: string
  pos: number
  end: number
}

const OPS2 = ['<=', '>=', '<>', '!=', '==', '||']
const OPS1 = '=<>(),.*+-/%;'
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  const push = (kind: TokKind, text: string, pos: number, end: number): void => {
    toks.push({ kind, text, raw: src.slice(pos, end), pos, end })
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (src.startsWith('--', i)) {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
      continue
    }
    if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2)
      if (e < 0) throw new SqlError('Unterminated comment', i, src.length)
      i = e + 2
      continue
    }
    const start = i
    if (c === "'" || c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new SqlError(c === "'" ? 'Unterminated string' : 'Unterminated quoted name', start, src.length)
        if (src[i] === close) {
          if (src[i + 1] === close) {
            s += close
            i += 2
            continue
          }
          i++
          break
        }
        s += src[i++]
      }
      if (c !== "'" && !s) throw new SqlError('Empty quoted name', start, i)
      push(c === "'" ? 'string' : 'quoted', s, start, i)
      continue
    }
    NUMBER.lastIndex = i
    const prev = toks[toks.length - 1]
    const afterName = prev && (prev.kind === 'word' || prev.kind === 'quoted' || prev.text === ')')
    if ((/\d/.test(c) || (c === '.' && !afterName && /\d/.test(src[i + 1] ?? ''))) && NUMBER.test(src)) {
      push('number', src.slice(start, NUMBER.lastIndex), start, NUMBER.lastIndex)
      i = NUMBER.lastIndex
      continue
    }
    WORD.lastIndex = i
    if (WORD.test(src)) {
      push('word', src.slice(start, WORD.lastIndex), start, WORD.lastIndex)
      i = WORD.lastIndex
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) {
      push('op', two === '==' ? '=' : two === '<>' ? '!=' : two, start, i + 2)
      i += 2
      continue
    }
    if (OPS1.includes(c)) {
      push('op', c, start, i + 1)
      i++
      continue
    }
    throw new SqlError(`Unexpected character '${c}'`, i, i + 1)
  }
  toks.push({ kind: 'eof', text: '', raw: '', pos: src.length, end: src.length })
  return toks
}

// ---------------------------------------------------------------------------
// AST

interface Span {
  pos: number
  end: number
}
type CallExpr = Span & { t: 'call'; name: string; args: Expr[]; distinct: boolean }
type ColExpr = Span & { t: 'col'; parts: string[] }
type Expr = Span &
  (
    | { t: 'col'; parts: string[] }
    | { t: 'star'; qual?: string[] }
    | { t: 'lit'; v: unknown }
    | { t: 'bin'; op: string; l: Expr; r: Expr }
    | { t: 'and'; items: Expr[] }
    | { t: 'or'; items: Expr[] }
    | { t: 'not'; e: Expr }
    | { t: 'neg'; e: Expr }
    | { t: 'in'; e: Expr; list: Expr[]; not: boolean }
    | { t: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean }
    | { t: 'like'; e: Expr; pat: Expr; not: boolean; ci: boolean; esc?: string }
    | { t: 'isnull'; e: Expr; not: boolean }
    | { t: 'call'; name: string; args: Expr[]; distinct: boolean }
  )

interface TableRef extends Span {
  name: string
  alias?: string
}
interface Join extends Span {
  type: 'inner' | 'left'
  table: TableRef
  on: Expr
}
interface SelectItem extends Span {
  expr: Expr
  alias?: string
}
interface OrderItem {
  expr: Expr
  dir: 1 | -1
}
interface Select {
  distinct: boolean
  star: boolean
  starQual?: string[]
  cols: SelectItem[]
  from: TableRef
  joins: Join[]
  where?: Expr
  groupBy: Expr[]
  having?: Expr
  orderBy: OrderItem[]
  limit?: number
  offset?: number
}

const RESERVED = new Set(
  (
    'SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING AND OR NOT AS ' +
    'ASC DESC IN IS NULL LIKE ILIKE BETWEEN UNION INTERSECT EXCEPT DISTINCT ALL CASE WHEN THEN ELSE END TRUE FALSE FETCH TOP ' +
    'ESCAPE WINDOW LATERAL INTO NULLS ROWS ROW'
  ).split(' ')
)
export const SQL_RESERVED: ReadonlySet<string> = RESERVED
/** Functions the translator understands (for autocomplete). */
export const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'UPPER', 'LOWER', 'LENGTH', 'CONCAT', 'SUBSTRING', 'TRIM', 'LTRIM', 'RTRIM', 'ABS', 'CEIL',
  'FLOOR', 'ROUND', 'MOD', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'COALESCE', 'IFNULL', 'ObjectId', 'ISODate'
]
const COMPARISONS = new Set(['=', '!=', '<', '<=', '>', '>='])
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
const DML = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'MERGE', 'REPLACE', 'UPSERT', 'GRANT', 'REVOKE']

// ---------------------------------------------------------------------------
// Parser

class Parser {
  private i = 0
  constructor(private toks: Tok[]) {}

  private get cur(): Tok {
    return this.toks[this.i]
  }
  private peek(n = 1): Tok {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)]
  }
  private get prevEnd(): number {
    return this.toks[Math.max(0, this.i - 1)].end
  }
  private advance(): Tok {
    const t = this.cur
    if (t.kind !== 'eof') this.i++
    return t
  }
  private isKw(kw: string, t = this.cur): boolean {
    return t.kind === 'word' && t.text.toUpperCase() === kw
  }
  private acceptKw(kw: string): Tok | null {
    return this.isKw(kw) ? this.advance() : null
  }
  private expectKw(kw: string): Tok {
    const t = this.acceptKw(kw)
    if (!t) throw this.unexpected(`Expected ${kw}`)
    return t
  }
  private isOp(op: string, t = this.cur): boolean {
    return t.kind === 'op' && t.text === op
  }
  private acceptOp(op: string): Tok | null {
    return this.isOp(op) ? this.advance() : null
  }
  private expectOp(op: string): Tok {
    const t = this.acceptOp(op)
    if (!t) throw this.unexpected(`Expected '${op}'`)
    return t
  }
  private unexpected(expected?: string, t = this.cur): SqlError {
    const found = t.kind === 'eof' ? 'end of query' : `'${t.raw}'`
    return new SqlError(expected ? `${expected} but found ${found}` : `Unexpected ${found}`, t.pos, t.end)
  }
  private fail(msg: string, t: Span = this.cur): SqlError {
    return new SqlError(msg, t.pos, t.end)
  }

  statement(): Select {
    const first = this.cur
    if (first.kind === 'eof') throw new SqlError('Enter a SELECT statement', 0, 0)
    if (first.kind === 'word') {
      const k = first.text.toUpperCase()
      if (k === 'WITH') throw this.fail('WITH (common table expressions) is not supported', first)
      if (DML.includes(k)) throw this.fail(`Only SELECT statements are supported (found ${k})`, first)
    }
    this.expectKw('SELECT')
    let limit: number | undefined
    let offset: number | undefined
    if (this.acceptKw('TOP')) limit = this.intLit('TOP')
    const distinct = !!this.acceptKw('DISTINCT')
    if (!distinct) this.acceptKw('ALL')

    const cols: SelectItem[] = []
    let star: Span | null = null
    let starQual: string[] | undefined
    do {
      if (this.isOp('*')) {
        star = this.advance()
        continue
      }
      const expr = this.expr()
      if (expr.t === 'star') {
        star = expr
        starQual = expr.qual
        continue
      }
      cols.push({ expr, alias: this.alias(), pos: expr.pos, end: this.prevEnd })
    } while (this.acceptOp(','))
    if (star && cols.length) throw this.fail('Combining * with other columns is not supported', star)

    if (this.isKw('INTO')) throw this.fail('SELECT … INTO is not supported')
    if (!this.isKw('FROM')) throw this.cur.kind === 'eof' ? this.fail('A FROM clause is required') : this.unexpected('Expected FROM')
    this.advance()
    const from = this.tableRef()
    if (this.isOp(',')) throw this.fail('Comma-separated tables are not supported; use JOIN … ON')

    const joins: Join[] = []
    for (;;) {
      const t = this.cur
      for (const k of ['RIGHT', 'FULL', 'CROSS', 'NATURAL']) {
        if (this.isKw(k)) throw this.fail(`${k} JOIN is not supported; use INNER JOIN or LEFT JOIN`)
      }
      let type: 'inner' | 'left'
      if (this.acceptKw('JOIN')) type = 'inner'
      else if (this.isKw('INNER')) {
        this.advance()
        this.expectKw('JOIN')
        type = 'inner'
      } else if (this.acceptKw('LEFT')) {
        this.acceptKw('OUTER')
        this.expectKw('JOIN')
        type = 'left'
      } else break
      const table = this.tableRef()
      if (this.isKw('USING')) throw this.fail('JOIN … USING is not supported; use ON')
      this.expectKw('ON')
      const on = this.expr()
      joins.push({ type, table, on, pos: t.pos, end: this.prevEnd })
    }

    const where = this.acceptKw('WHERE') ? this.expr() : undefined
    const groupBy: Expr[] = []
    if (this.acceptKw('GROUP')) {
      this.expectKw('BY')
      do groupBy.push(this.expr())
      while (this.acceptOp(','))
    }
    const having = this.acceptKw('HAVING') ? this.expr() : undefined
    const orderBy: OrderItem[] = []
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY')
      do {
        const expr = this.expr()
        const dir = this.acceptKw('DESC') ? -1 : (this.acceptKw('ASC'), 1)
        if (this.isKw('NULLS')) throw this.fail('NULLS FIRST / LAST is not supported')
        orderBy.push({ expr, dir })
      } while (this.acceptOp(','))
    }

    let sawLimit = false
    let sawOffset = false
    for (;;) {
      if (!sawLimit && this.acceptKw('LIMIT')) {
        sawLimit = true
        if (this.acceptKw('ALL')) continue
        const n = this.intLit('LIMIT')
        if (this.acceptOp(',')) {
          offset = n
          sawOffset = true
          limit = this.intLit('LIMIT')
        } else limit = n
      } else if (!sawOffset && this.acceptKw('OFFSET')) {
        sawOffset = true
        offset = this.intLit('OFFSET')
        if (!this.acceptKw('ROWS')) this.acceptKw('ROW')
      } else if (!sawLimit && this.acceptKw('FETCH')) {
        sawLimit = true
        if (!this.acceptKw('FIRST')) this.expectKw('NEXT')
        limit = this.intLit('FETCH')
        if (!this.acceptKw('ROWS')) this.expectKw('ROW')
        this.expectKw('ONLY')
      } else break
    }

    for (const k of ['UNION', 'INTERSECT', 'EXCEPT']) if (this.isKw(k)) throw this.fail(`${k} is not supported`)
    if (this.acceptOp(';') && this.cur.kind !== 'eof') throw this.fail('Only one statement can be run at a time')
    if (this.cur.kind !== 'eof') {
      if (this.isKw('WHERE') || this.isKw('GROUP') || this.isKw('HAVING') || this.isKw('ORDER') || this.isKw('LIMIT') || this.isKw('OFFSET')) {
        throw this.fail(`${this.cur.text.toUpperCase()} is out of order; clauses go SELECT, FROM, JOIN, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT`)
      }
      throw this.unexpected()
    }
    return { distinct, star: !!star, starQual, cols, from, joins, where, groupBy, having, orderBy, limit, offset }
  }

  private intLit(what: string): number {
    const t = this.cur
    if (t.kind !== 'number' || !/^\d+$/.test(t.text)) throw this.unexpected(`${what} needs a whole number`)
    this.advance()
    return Number(t.text)
  }

  private alias(): string | undefined {
    if (this.acceptKw('AS')) {
      const t = this.cur
      if (t.kind === 'word' || t.kind === 'quoted' || t.kind === 'string') return this.advance().text
      throw this.unexpected('Expected an alias')
    }
    const t = this.cur
    if (t.kind === 'quoted' || (t.kind === 'word' && !RESERVED.has(t.text.toUpperCase()))) return this.advance().text
    return undefined
  }

  private name(allowReserved = false): string {
    const t = this.cur
    if (t.kind === 'quoted') return this.advance().text
    if (t.kind === 'word') {
      if (!allowReserved && RESERVED.has(t.text.toUpperCase())) throw this.unexpected('Expected a name (quote reserved words with `backticks`)')
      return this.advance().text
    }
    throw this.unexpected('Expected a name')
  }

  private tableRef(): TableRef {
    const t = this.cur
    if (this.isOp('(')) throw this.fail('Subqueries are not supported')
    let name = this.name()
    while (this.acceptOp('.')) name += '.' + this.name(true)
    return { name, alias: this.alias(), pos: t.pos, end: this.prevEnd }
  }

  expr(): Expr {
    return this.or()
  }

  private or(): Expr {
    const first = this.and()
    if (!this.isKw('OR')) return first
    const items = [first]
    while (this.acceptKw('OR')) items.push(this.and())
    return { t: 'or', items, pos: first.pos, end: this.prevEnd }
  }

  private and(): Expr {
    const first = this.not()
    if (!this.isKw('AND')) return first
    const items = [first]
    while (this.acceptKw('AND')) items.push(this.not())
    return { t: 'and', items, pos: first.pos, end: this.prevEnd }
  }

  private not(): Expr {
    const t = this.acceptKw('NOT')
    if (t) {
      const e = this.not()
      return { t: 'not', e, pos: t.pos, end: e.end }
    }
    return this.predicate()
  }

  private predicate(): Expr {
    const e = this.additive()
    const pos = e.pos
    const t = this.cur
    if (t.kind === 'op' && COMPARISONS.has(t.text)) {
      this.advance()
      const r = this.additive()
      return { t: 'bin', op: t.text, l: e, r, pos, end: r.end }
    }
    let not = false
    if (this.isKw('NOT') && ['IN', 'LIKE', 'ILIKE', 'BETWEEN'].some((k) => this.isKw(k, this.peek()))) {
      this.advance()
      not = true
    }
    if (this.acceptKw('IN')) {
      this.expectOp('(')
      if (this.isKw('SELECT')) throw this.fail('Subqueries are not supported')
      const list: Expr[] = []
      if (!this.isOp(')')) {
        do list.push(this.additive())
        while (this.acceptOp(','))
      }
      this.expectOp(')')
      return { t: 'in', e, list, not, pos, end: this.prevEnd }
    }
    if (this.acceptKw('BETWEEN')) {
      const lo = this.additive()
      this.expectKw('AND')
      const hi = this.additive()
      return { t: 'between', e, lo, hi, not, pos, end: hi.end }
    }
    const like = this.acceptKw('LIKE') ?? this.acceptKw('ILIKE')
    if (like) {
      const pat = this.additive()
      let esc: string | undefined
      if (this.acceptKw('ESCAPE')) {
        const s = this.cur
        if (s.kind !== 'string' || s.text.length !== 1) throw this.unexpected('ESCAPE needs a single-character string')
        esc = this.advance().text
      }
      return { t: 'like', e, pat, not, ci: like.text.toUpperCase() === 'ILIKE', esc, pos, end: this.prevEnd }
    }
    if (this.acceptKw('IS')) {
      const n = !!this.acceptKw('NOT')
      if (this.isKw('TRUE') || this.isKw('FALSE')) {
        const v = this.advance().text.toUpperCase() === 'TRUE'
        const lit: Expr = { t: 'lit', v, pos: t.pos, end: this.prevEnd }
        return { t: 'bin', op: n ? '!=' : '=', l: e, r: lit, pos, end: this.prevEnd }
      }
      this.expectKw('NULL')
      return { t: 'isnull', e, not: n, pos, end: this.prevEnd }
    }
    return e
  }

  private additive(): Expr {
    let l = this.multiplicative()
    for (;;) {
      const t = this.cur
      if (!(this.isOp('+') || this.isOp('-') || this.isOp('||'))) return l
      this.advance()
      const r = this.multiplicative()
      l = { t: 'bin', op: t.text, l, r, pos: l.pos, end: r.end }
    }
  }

  private multiplicative(): Expr {
    let l = this.unary()
    for (;;) {
      const t = this.cur
      if (!(this.isOp('*') || this.isOp('/') || this.isOp('%'))) return l
      this.advance()
      const r = this.unary()
      l = { t: 'bin', op: t.text, l, r, pos: l.pos, end: r.end }
    }
  }

  private unary(): Expr {
    const t = this.cur
    if (this.acceptOp('-')) {
      const e = this.unary()
      if (e.t === 'lit' && typeof e.v === 'number') return { t: 'lit', v: -e.v, pos: t.pos, end: e.end }
      return { t: 'neg', e, pos: t.pos, end: e.end }
    }
    if (this.acceptOp('+')) return this.unary()
    return this.primary()
  }

  private primary(): Expr {
    const t = this.cur
    const lit = (v: unknown): Expr => ({ t: 'lit', v, pos: t.pos, end: this.prevEnd })
    if (t.kind === 'number') {
      this.advance()
      return lit(Number(t.text))
    }
    if (t.kind === 'string') {
      this.advance()
      return lit(t.text)
    }
    if (this.acceptOp('(')) {
      if (this.isKw('SELECT')) throw this.fail('Subqueries are not supported')
      const e = this.expr()
      this.expectOp(')')
      return { ...e, pos: t.pos, end: this.prevEnd }
    }
    if (t.kind === 'quoted') return this.colRef()
    if (t.kind === 'word') {
      const k = t.text.toUpperCase()
      if (k === 'TRUE' || k === 'FALSE' || k === 'NULL') {
        this.advance()
        return lit(k === 'NULL' ? null : k === 'TRUE')
      }
      if ((k === 'DATE' || k === 'TIMESTAMP') && this.peek().kind === 'string') {
        this.advance()
        const s = this.advance()
        return lit(dateOf(s.text, s))
      }
      if (k === 'CASE') throw this.fail('CASE expressions are not supported')
      if (k === 'INTERVAL') throw this.fail('INTERVAL is not supported')
      if (this.isOp('(', this.peek())) return this.call()
      if (RESERVED.has(k)) throw this.unexpected('Expected an expression')
      return this.colRef()
    }
    throw this.unexpected('Expected an expression')
  }

  private colRef(): Expr {
    const t = this.cur
    const parts = [this.name()]
    while (this.acceptOp('.')) {
      if (this.isOp('*')) {
        this.advance()
        return { t: 'star', qual: parts, pos: t.pos, end: this.prevEnd }
      }
      parts.push(this.name(true))
    }
    return { t: 'col', parts, pos: t.pos, end: this.prevEnd }
  }

  private call(): Expr {
    const t = this.advance()
    const name = t.text.toUpperCase()
    this.expectOp('(')
    let distinct = false
    const args: Expr[] = []
    if (this.isOp('*')) {
      const s = this.advance()
      if (name !== 'COUNT') throw this.fail(`${name}(*) is not valid; only COUNT(*) accepts *`, s)
      args.push({ t: 'star', pos: s.pos, end: s.end })
    } else {
      if (this.acceptKw('DISTINCT')) distinct = true
      if (this.isKw('SELECT')) throw this.fail('Subqueries are not supported')
      if (!this.isOp(')')) {
        do args.push(this.expr())
        while (this.acceptOp(','))
      }
    }
    this.expectOp(')')
    if (this.isKw('OVER')) throw this.fail('Window functions (OVER) are not supported')
    const span = { pos: t.pos, end: this.prevEnd }
    if (name === 'OBJECTID') {
      const a = args[0]
      if (args.length !== 1 || a.t !== 'lit' || typeof a.v !== 'string' || !/^[0-9a-fA-F]{24}$/.test(a.v)) {
        throw new SqlError('ObjectId() needs a 24-character hex string', span.pos, span.end)
      }
      return { t: 'lit', v: new ObjectId(a.v), ...span }
    }
    if (name === 'ISODATE' || name === 'DATE' || name === 'TIMESTAMP') {
      const a = args[0]
      if (args.length !== 1 || a.t !== 'lit' || typeof a.v !== 'string') throw new SqlError(`${name}() needs a date string`, span.pos, span.end)
      return { t: 'lit', v: dateOf(a.v, a), ...span }
    }
    if (distinct && name !== 'COUNT') throw new SqlError(`DISTINCT is only supported in COUNT(DISTINCT …)`, span.pos, span.end)
    return { t: 'call', name, args, distinct, ...span }
  }
}

function dateOf(s: string, at: Span): Date {
  const d = parseUtcDate(s)
  if (isNaN(d.getTime())) throw new SqlError(`Invalid date '${s}'`, at.pos, at.end)
  return d
}

// ---------------------------------------------------------------------------
// Translation helpers

const isPlainObject = (v: unknown): v is Doc => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
const isOpObject = (v: unknown): v is Doc => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'))
const isLit = (e: Expr): e is Span & { t: 'lit'; v: unknown } => e.t === 'lit'

const FLIP: Record<string, string> = { '=': '=', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' }
const CMP_OP: Record<string, string> = { '=': '$eq', '!=': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' }
const ARITH_OP: Record<string, string> = { '+': '$add', '-': '$subtract', '*': '$multiply', '/': '$divide', '%': '$mod', '||': '$concat' }

function flatten(e: Expr, kind: 'and' | 'or'): Expr[] {
  return e.t === kind ? e.items.flatMap((x) => flatten(x, kind)) : [e]
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** SQL LIKE pattern → anchored regular expression source. */
export function likeToRegex(pattern: string, esc = '\\'): string {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === esc && i + 1 < pattern.length) re += escapeRe(pattern[++i])
    else if (c === '%') re += '.*'
    else if (c === '_') re += '.'
    else re += escapeRe(c)
  }
  // A leading / trailing `.*` always comes from `%` (a literal `*` is escaped).
  if (/^(\.\*)+$/.test(re)) return ''
  let head = '^'
  let tail = '$'
  if (re.startsWith('.*')) {
    re = re.slice(2)
    head = ''
  }
  if (re.endsWith('.*')) {
    re = re.slice(0, -2)
    tail = ''
  }
  return head + re + tail
}

/** Merge AND-ed filters into one object when keys don't clash. */
function mergeAnd(filters: Doc[]): Doc {
  const parts = filters.flatMap((f) => (Object.keys(f).length === 1 && Array.isArray(f.$and) ? (f.$and as Doc[]) : [f])).filter((f) => Object.keys(f).length)
  const out: Doc = {}
  for (const f of parts) {
    for (const [k, v] of Object.entries(f)) {
      if (!(k in out)) out[k] = v
      else if (!k.startsWith('$') && isOpObject(out[k]) && isOpObject(v) && Object.keys(v).every((o) => !(o in (out[k] as Doc)))) out[k] = { ...(out[k] as Doc), ...v }
      else return { $and: parts }
    }
  }
  return out
}

function negate(f: Doc): Doc {
  const keys = Object.keys(f)
  if (keys.length !== 1) return { $nor: [f] }
  const k = keys[0]
  const v = f[k]
  if (k === '$or') return { $nor: v }
  if (k === '$nor') return (v as Doc[]).length === 1 ? (v as Doc[])[0] : { $or: v }
  if (k === '$expr') return { $expr: { $not: [v] } }
  if (k.startsWith('$')) return { $nor: [f] }
  if (isOpObject(v)) {
    const ops = Object.keys(v)
    if (ops.length === 1) {
      if (ops[0] === '$ne') return { [k]: v.$ne }
      if (ops[0] === '$eq') return { [k]: { $ne: v.$eq } }
      if (ops[0] === '$in') return { [k]: { $nin: v.$in } }
      if (ops[0] === '$nin') return { [k]: { $in: v.$nin } }
      if (ops[0] === '$not') return { [k]: v.$not }
    }
    return { [k]: { $not: v } }
  }
  return { [k]: { $ne: v } }
}

interface Ctx {
  src: string
  /** Field path an expression reads directly, or null. */
  ref(e: Expr): string | null
  /** Error for a column that cannot be used here. */
  colError(e: Expr): SqlError
  aggError(e: Expr): SqlError
}

function literal(v: unknown): unknown {
  return typeof v === 'string' && v.startsWith('$') ? { $literal: v } : v
}

function likePattern(e: Span & { pat: Expr; esc?: string; ci: boolean }): { $regex: string; $options?: string } {
  const p = e.pat
  if (!isLit(p) || typeof p.v !== 'string') throw new SqlError('LIKE needs a string pattern', p.pos, p.end)
  const re = likeToRegex(p.v, e.esc)
  return e.ci ? { $regex: re, $options: 'i' } : { $regex: re }
}

/** WHERE / HAVING expression → query filter. */
function filterOf(e: Expr, c: Ctx): Doc {
  switch (e.t) {
    case 'and':
      return mergeAnd(e.items.map((x) => filterOf(x, c)))
    case 'or':
      return { $or: flatten(e, 'or').map((x) => filterOf(x, c)) }
    case 'not':
      return negate(filterOf(e.e, c))
    case 'bin': {
      if (!COMPARISONS.has(e.op)) break
      const lp = c.ref(e.l)
      const rp = c.ref(e.r)
      if (lp !== null && isLit(e.r)) return compare(lp, e.op, e.r.v)
      if (rp !== null && isLit(e.l)) return compare(rp, FLIP[e.op], e.l.v)
      break
    }
    case 'in': {
      const p = c.ref(e.e)
      if (p !== null && e.list.every(isLit)) return { [p]: { [e.not ? '$nin' : '$in']: e.list.map((x) => (x as { v: unknown }).v) } }
      break
    }
    case 'between': {
      const p = c.ref(e.e)
      if (p !== null && isLit(e.lo) && isLit(e.hi)) {
        return e.not ? { $or: [{ [p]: { $lt: e.lo.v } }, { [p]: { $gt: e.hi.v } }] } : { [p]: { $gte: e.lo.v, $lte: e.hi.v } }
      }
      break
    }
    case 'like': {
      const p = c.ref(e.e)
      if (p !== null) {
        const re = likePattern(e)
        return { [p]: e.not ? { $not: re } : re }
      }
      break
    }
    case 'isnull': {
      const p = c.ref(e.e)
      if (p !== null) return { [p]: e.not ? { $ne: null } : null }
      break
    }
    case 'col': {
      const p = c.ref(e)
      if (p !== null) return { [p]: true }
      break
    }
    case 'lit':
      if (e.v === true) return {}
      break
  }
  return { $expr: aggOf(e, c) }
}

function compare(path: string, op: string, v: unknown): Doc {
  if (op === '=') return { [path]: isPlainObject(v) ? { $eq: v } : v }
  return { [path]: { [CMP_OP[op]]: v } }
}

const nArgs = (e: CallExpr, min: number, max = min): void => {
  if (e.args.length < min || e.args.length > max) {
    const n = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`
    throw new SqlError(`${e.name}() takes ${n} argument${min === 1 && max === 1 ? '' : 's'}`, e.pos, e.end)
  }
}

function scalarCall(e: CallExpr, c: Ctx): unknown {
  const a = e.args.map((x) => aggOf(x, c))
  const one = (op: string): Doc => (nArgs(e, 1), { [op]: a[0] })
  switch (e.name) {
    case 'UPPER':
    case 'UCASE':
      return one('$toUpper')
    case 'LOWER':
    case 'LCASE':
      return one('$toLower')
    case 'LENGTH':
    case 'LEN':
    case 'CHAR_LENGTH':
    case 'CHARACTER_LENGTH':
      return one('$strLenCP')
    case 'TRIM':
      return (nArgs(e, 1), { $trim: { input: a[0] } })
    case 'LTRIM':
      return (nArgs(e, 1), { $ltrim: { input: a[0] } })
    case 'RTRIM':
      return (nArgs(e, 1), { $rtrim: { input: a[0] } })
    case 'ABS':
      return one('$abs')
    case 'CEIL':
    case 'CEILING':
      return one('$ceil')
    case 'FLOOR':
      return one('$floor')
    case 'ROUND':
      return (nArgs(e, 1, 2), { $round: a })
    case 'MOD':
      return (nArgs(e, 2), { $mod: a })
    case 'YEAR':
      return one('$year')
    case 'MONTH':
      return one('$month')
    case 'DAY':
    case 'DAYOFMONTH':
      return one('$dayOfMonth')
    case 'HOUR':
      return one('$hour')
    case 'MINUTE':
      return one('$minute')
    case 'SECOND':
      return one('$second')
    case 'CONCAT':
      return (nArgs(e, 1, Infinity), { $concat: a })
    case 'COALESCE':
    case 'IFNULL':
    case 'NVL':
      return (nArgs(e, 2, Infinity), { $ifNull: a })
    case 'SUBSTRING':
    case 'SUBSTR':
    case 'MID': {
      nArgs(e, 2, 3)
      const start = typeof a[1] === 'number' ? Math.max(0, a[1] - 1) : { $subtract: [a[1], 1] }
      return { $substrCP: [a[0], start, a.length === 3 ? a[2] : { $strLenCP: a[0] }] }
    }
  }
  throw new SqlError(`Unsupported function ${e.name}()`, e.pos, e.end)
}

/** Expression → aggregation expression. */
function aggOf(e: Expr, c: Ctx): unknown {
  const r = c.ref(e)
  if (r !== null) return `$${r}`
  switch (e.t) {
    case 'col':
      throw c.colError(e)
    case 'star':
      throw new SqlError('* is not allowed here', e.pos, e.end)
    case 'lit':
      return literal(e.v)
    case 'neg':
      return { $multiply: [-1, aggOf(e.e, c)] }
    case 'not':
      return { $not: [aggOf(e.e, c)] }
    case 'and':
    case 'or':
      return { [`$${e.t}`]: flatten(e, e.t).map((x) => aggOf(x, c)) }
    case 'bin': {
      const op = CMP_OP[e.op] ?? ARITH_OP[e.op]
      if (op === '$add' || op === '$multiply' || op === '$concat') {
        const items = [e.l, e.r].flatMap((x) => (x.t === 'bin' && x.op === e.op ? [x.l, x.r] : [x]))
        return { [op]: items.map((x) => aggOf(x, c)) }
      }
      return { [op]: [aggOf(e.l, c), aggOf(e.r, c)] }
    }
    case 'in': {
      const x = { $in: [aggOf(e.e, c), e.list.map((v) => aggOf(v, c))] }
      return e.not ? { $not: [x] } : x
    }
    case 'between': {
      const v = aggOf(e.e, c)
      const x = { $and: [{ $gte: [v, aggOf(e.lo, c)] }, { $lte: [v, aggOf(e.hi, c)] }] }
      return e.not ? { $not: [x] } : x
    }
    case 'like': {
      const p = likePattern(e)
      const x = { $regexMatch: { input: aggOf(e.e, c), regex: p.$regex, ...(p.$options ? { options: p.$options } : {}) } }
      return e.not ? { $not: [x] } : x
    }
    case 'isnull':
      return { [e.not ? '$ne' : '$eq']: [{ $ifNull: [aggOf(e.e, c), null] }, null] }
    case 'call':
      if (AGGREGATES.has(e.name)) throw c.aggError(e)
      return scalarCall(e, c)
  }
}

function walk(e: Expr, fn: (x: Expr) => boolean | void): void {
  if (fn(e) === false) return
  switch (e.t) {
    case 'bin':
      walk(e.l, fn)
      walk(e.r, fn)
      break
    case 'and':
    case 'or':
      e.items.forEach((x) => walk(x, fn))
      break
    case 'not':
    case 'neg':
    case 'isnull':
      walk(e.e, fn)
      break
    case 'in':
      walk(e.e, fn)
      e.list.forEach((x) => walk(x, fn))
      break
    case 'between':
      walk(e.e, fn)
      walk(e.lo, fn)
      walk(e.hi, fn)
      break
    case 'like':
      walk(e.e, fn)
      walk(e.pat, fn)
      break
    case 'call':
      e.args.forEach((x) => walk(x, fn))
      break
  }
}

const aggCalls = (e: Expr): CallExpr[] => {
  const out: CallExpr[] = []
  walk(e, (x) => {
    if (x.t === 'call' && AGGREGATES.has(x.name)) {
      out.push(x)
      return false
    }
  })
  return out
}

/** Readable output name from the SQL text of an expression. */
function textName(src: string, e: Span): string {
  return src.slice(e.pos, e.end).replace(/\s+/g, ' ').replace(/\./g, '_').replace(/^\$+/, '') || 'expr'
}

function uniqueName(name: string, used: Set<string>): string {
  let n = name
  for (let i = 2; used.has(n); i++) n = `${name}_${i}`
  used.add(n)
  return n
}

// ---------------------------------------------------------------------------
// Translation

interface Table {
  name: string
  alias?: string
  /** Field the joined document is stored under; '' for the main collection. */
  as: string
}

interface Resolved {
  table: number
  path: string
  inner: string
}

function translate(q: Select, src: string): SqlTranslation {
  const tables: Table[] = [{ name: q.from.name, alias: q.from.alias, as: '' }]
  const usedAs = new Set<string>()
  for (const j of q.joins) {
    const as = uniqueName((j.table.alias ?? j.table.name).replace(/\./g, '_'), usedAs)
    const dup = tables.find((t) => (t.alias ?? t.name).toLowerCase() === (j.table.alias ?? j.table.name).toLowerCase())
    if (dup) throw new SqlError(`Table name '${j.table.alias ?? j.table.name}' is used twice; give it an alias`, j.table.pos, j.table.end)
    tables.push({ name: j.table.name, alias: j.table.alias, as })
  }

  const matchTable = (q0: string): number => {
    const l = q0.toLowerCase()
    let i = tables.findIndex((t) => t.alias?.toLowerCase() === l)
    if (i < 0) i = tables.findIndex((t) => t.name.toLowerCase() === l)
    return i
  }
  const resolve = (c: ColExpr): Resolved => {
    if (c.parts.length > 1) {
      const i = matchTable(c.parts[0])
      if (i >= 0) {
        const inner = c.parts.slice(1).join('.')
        return { table: i, inner, path: i === 0 ? inner : `${tables[i].as}.${inner}` }
      }
      // A multi-part main collection name (`FROM a.b`) used as qualifier.
      for (let n = c.parts.length - 1; n > 1; n--) {
        const i2 = matchTable(c.parts.slice(0, n).join('.'))
        if (i2 >= 0) {
          const inner = c.parts.slice(n).join('.')
          return { table: i2, inner, path: i2 === 0 ? inner : `${tables[i2].as}.${inner}` }
        }
      }
    }
    const p = c.parts.join('.')
    return { table: 0, inner: p, path: p }
  }
  const pathOf = (c: ColExpr): string => {
    const r = resolve(c)
    if (r.inner.split('.').some((s) => s.startsWith('$') || s === '')) throw new SqlError(`Invalid field name '${r.inner}'`, c.pos, c.end)
    return r.path
  }
  const canon = (e: Expr): string =>
    JSON.stringify(e, function (this: unknown, k, v) {
      if (k === 'pos' || k === 'end') return undefined
      if (v && typeof v === 'object' && (v as Expr).t === 'col') return { col: pathOf(v as ColExpr) }
      return v
    })

  if (q.starQual && matchTable(q.starQual.join('.')) !== 0) {
    throw new SqlError(`'${q.starQual.join('.')}.*' is not supported; use * or list the columns`, 0, src.length)
  }

  const plain: Ctx = {
    src,
    ref: (e) => (e.t === 'col' ? pathOf(e) : null),
    colError: (e) => new SqlError('Unexpected column', e.pos, e.end),
    aggError: (e) => new SqlError(`Aggregate function ${(e as CallExpr).name}() is not allowed here`, e.pos, e.end)
  }

  const badWhere = q.where && aggCalls(q.where)[0]
  if (badWhere) throw new SqlError('Aggregate functions are not allowed in WHERE; use HAVING', badWhere.pos, badWhere.end)
  for (const e of q.joins.map((j) => j.on)) {
    const bad = aggCalls(e)[0]
    if (bad) throw new SqlError('Aggregate functions are not allowed in JOIN … ON', bad.pos, bad.end)
  }
  for (const e of q.groupBy) {
    const bad = aggCalls(e)[0]
    if (bad) throw new SqlError('Aggregate functions are not allowed in GROUP BY', bad.pos, bad.end)
  }

  // ORDER BY / GROUP BY may name a select alias or an ordinal.
  const aliasItem = (e: Expr): SelectItem | undefined => {
    if (e.t === 'col' && e.parts.length === 1) return q.cols.find((s) => s.alias?.toLowerCase() === e.parts[0].toLowerCase())
    return undefined
  }
  const ordinalItem = (e: Expr): SelectItem | undefined => {
    if (!isLit(e) || typeof e.v !== 'number') return undefined
    const item = q.cols[e.v - 1]
    if (!Number.isInteger(e.v) || !item) throw new SqlError(`Column position ${e.v} is out of range`, e.pos, e.end)
    return item
  }

  const aggs = [...q.cols.flatMap((s) => aggCalls(s.expr)), ...(q.having ? aggCalls(q.having) : []), ...q.orderBy.flatMap((o) => aggCalls(o.expr))]
  for (const a of aggs) {
    for (const arg of a.args) {
      const nested = aggCalls(arg)[0]
      if (nested) throw new SqlError('Nested aggregate functions are not supported', nested.pos, nested.end)
    }
  }
  const grouped = q.groupBy.length > 0 || aggs.length > 0 || q.distinct
  if (q.star && grouped) throw new SqlError('SELECT * cannot be combined with GROUP BY, DISTINCT or aggregate functions', 0, src.length)
  if (q.having && !grouped) throw new SqlError('HAVING needs GROUP BY or an aggregate function', q.having.pos, q.having.end)

  // Grouped results are flat rows, so `a.b` becomes column `b` as in SQL; otherwise paths keep their nesting.
  const outName = (s: SelectItem): string =>
    s.alias ?? (s.expr.t === 'col' ? (grouped ? pathOf(s.expr).split('.').pop()! : pathOf(s.expr)) : textName(src, s.expr))
  const used = new Set<string>()
  const outputs = q.cols.map((s) => ({ item: s, name: uniqueName(outName(s), used) }))
  const outputOf = (e: Expr): string | undefined => {
    const a = aliasItem(e) ?? ordinalItem(e)
    if (a) return outputs.find((o) => o.item === a)!.name
    const k = canon(e)
    return outputs.find((o) => canon(o.item.expr) === k)?.name
  }

  const coll = q.from.name
  const computedCol = (s: SelectItem): boolean => s.expr.t !== 'col' || (s.alias !== undefined && s.alias !== pathOf(s.expr))
  const orderComputed = q.orderBy.some((o) => {
    const target = aliasItem(o.expr) ?? ordinalItem(o.expr)
    return target ? target.expr.t !== 'col' : o.expr.t !== 'col'
  })

  if (!grouped && !q.joins.length && !q.cols.some(computedCol) && !orderComputed) {
    const filter = q.where ? filterOf(q.where, plain) : {}
    let projection: Doc | null = null
    if (!q.star) {
      projection = {}
      for (const s of q.cols) projection[pathOf(s.expr as ColExpr)] = 1
      if (!('_id' in projection)) projection._id = 0
    }
    let sort: Doc | null = null
    if (q.orderBy.length) {
      sort = {}
      for (const o of q.orderBy) {
        const target = aliasItem(o.expr) ?? ordinalItem(o.expr)
        sort[pathOf((target?.expr ?? o.expr) as ColExpr)] = o.dir
      }
    }
    return { coll, kind: 'find', filter, projection, sort, skip: q.offset ?? 0, limit: q.limit ?? 0 }
  }

  const pipeline: Doc[] = []

  // WHERE conditions on the main collection only run before the joins.
  const conjuncts = q.where ? flatten(q.where, 'and') : []
  const mainOnly = (e: Expr): boolean => {
    let ok = true
    walk(e, (x) => {
      if (x.t === 'col' && resolve(x).table !== 0) ok = false
    })
    return ok
  }
  const pre = q.joins.length ? conjuncts.filter(mainOnly) : conjuncts
  const post = conjuncts.filter((x) => !pre.includes(x))
  const andOf = (items: Expr[]): Expr => (items.length === 1 ? items[0] : { t: 'and', items, pos: items[0].pos, end: items[items.length - 1].end })
  if (pre.length) pipeline.push({ $match: filterOf(andOf(pre), plain) })

  q.joins.forEach((j, n) => {
    const idx = n + 1
    const conds = flatten(j.on, 'and')
    let eq: { local: string; foreign: string } | null = null
    const rest: Expr[] = []
    for (const cnd of conds) {
      if (!eq && cnd.t === 'bin' && cnd.op === '=' && cnd.l.t === 'col' && cnd.r.t === 'col') {
        const l = resolve(cnd.l)
        const r = resolve(cnd.r)
        for (const c of [l, r]) if (c.table > idx) throw new SqlError(`'${tables[c.table].alias ?? tables[c.table].name}' is joined later; ON can only use earlier tables`, cnd.pos, cnd.end)
        if (l.table === idx && r.table < idx) eq = { local: r.path, foreign: l.inner }
        else if (r.table === idx && l.table < idx) eq = { local: l.path, foreign: r.inner }
        if (eq) continue
      }
      rest.push(cnd)
    }
    if (!eq) throw new SqlError(`JOIN … ON needs an equality between a column of '${j.table.alias ?? j.table.name}' and a column of an earlier table`, j.on.pos, j.on.end)
    if (rest.length && j.type === 'left') throw new SqlError('LEFT JOIN … ON supports a single equality condition', rest[0].pos, rest[rest.length - 1].end)
    const as = tables[idx].as
    pipeline.push({ $lookup: { from: j.table.name, localField: eq.local, foreignField: eq.foreign, as } })
    pipeline.push({ $unwind: j.type === 'left' ? { path: `$${as}`, preserveNullAndEmptyArrays: true } : `$${as}` })
    if (rest.length) pipeline.push({ $match: filterOf(andOf(rest), plain) })
  })
  if (post.length) pipeline.push({ $match: filterOf(andOf(post), plain) })

  const tail = (): void => {
    if (q.offset) pipeline.push({ $skip: q.offset })
    if (q.limit !== undefined) pipeline.push({ $limit: q.limit })
  }

  if (!grouped) {
    let projectStage: Doc | null = null
    if (!q.star) {
      const project: Doc = {}
      // $project emits included (`: 1`) fields before computed ones; computed references keep the SQL column order.
      const keepOrder = q.cols.some(computedCol)
      for (const o of outputs) {
        const s = o.item
        if (s.expr.t === 'star') throw new SqlError('Qualified * is not supported', s.pos, s.end)
        if (s.expr.t === 'col' && !computedCol(s)) project[pathOf(s.expr)] = keepOrder ? `$${pathOf(s.expr)}` : 1
        else project[o.name] = aggOf(s.expr, plain)
      }
      if (!('_id' in project)) project._id = 0
      projectStage = { $project: project }
    }
    const sortAfter = !q.star && orderComputed
    if (q.orderBy.length && !sortAfter) {
      const sort: Doc = {}
      for (const o of q.orderBy) {
        const target = aliasItem(o.expr) ?? ordinalItem(o.expr)
        const e = target?.expr ?? o.expr
        if (e.t !== 'col') throw new SqlError('ORDER BY expressions are not supported; select the expression with an alias and order by the alias', e.pos, e.end)
        sort[pathOf(e)] = o.dir
      }
      pipeline.push({ $sort: sort })
    }
    if (sortAfter) {
      if (projectStage) pipeline.push(projectStage)
      pipeline.push({ $sort: sortOnOutputs() })
      tail()
    } else {
      tail()
      if (projectStage) pipeline.push(projectStage)
    }
    return { coll, kind: 'aggregate', pipeline }
  }

  function sortOnOutputs(): Doc {
    const sort: Doc = {}
    for (const o of q.orderBy) {
      const name = outputOf(o.expr)
      if (!name) throw new SqlError('When sorting by a computed column, every ORDER BY item must be in the select list', o.expr.pos, o.expr.end)
      sort[name] = o.dir
    }
    return sort
  }

  // Grouping
  const keyNames = new Set<string>()
  const keys: { name: string; canon: string; expr: Expr }[] = []
  const keyExprs = q.groupBy.length ? q.groupBy.map((e) => aliasItem(e)?.expr ?? ordinalItem(e)?.expr ?? e) : q.distinct && !aggs.length ? q.cols.map((s) => s.expr) : []
  for (const e of keyExprs) {
    const k = canon(e)
    if (keys.some((x) => x.canon === k)) continue
    const sel = q.cols.find((s) => canon(s.expr) === k)
    const base = sel?.alias ?? (e.t === 'col' ? pathOf(e) : textName(src, e))
    keys.push({ name: uniqueName(base.replace(/\./g, '_').replace(/^\$+/, '') || 'key', keyNames), canon: k, expr: e })
  }

  const accs: { name: string; canon: string; op: Doc; countDistinct: boolean }[] = []
  for (const a of aggs) {
    const k = canon(a)
    if (accs.some((x) => x.canon === k)) continue
    const sel = q.cols.find((s) => canon(s.expr) === k)
    const name = uniqueName((sel?.alias ?? textName(src, a)).replace(/\./g, '_').replace(/^\$+/, ''), keyNames)
    let op: Doc
    let countDistinct = false
    if (a.name === 'COUNT') {
      nArgs(a, 1)
      if (a.args[0].t === 'star') op = { $sum: 1 }
      else if (a.distinct) {
        op = { $addToSet: aggOf(a.args[0], plain) }
        countDistinct = true
      } else op = { $sum: { $cond: [{ $eq: [{ $ifNull: [aggOf(a.args[0], plain), null] }, null] }, 0, 1] } }
    } else {
      nArgs(a, 1)
      op = { [`$${a.name.toLowerCase()}`]: aggOf(a.args[0], plain) }
    }
    accs.push({ name, canon: k, op, countDistinct })
  }

  const groupRef = (e: Expr, seen = new Set<SelectItem>()): string | null => {
    if (e.t === 'star') return null
    const k = canon(e)
    const acc = accs.find((x) => x.canon === k)
    if (acc) return acc.name
    const key = keys.find((x) => x.canon === k)
    if (key) return `_id.${key.name}`
    const al = aliasItem(e)
    if (al && !seen.has(al) && canon(al.expr) !== k) {
      seen.add(al)
      return groupRef(al.expr, seen)
    }
    return null
  }
  const gctx: Ctx = {
    src,
    ref: (e) => groupRef(e),
    colError: (e) => new SqlError(`Column '${src.slice(e.pos, e.end)}' must be in GROUP BY or inside an aggregate function`, e.pos, e.end),
    aggError: (e) => new SqlError('Unexpected aggregate function', e.pos, e.end)
  }

  const group: Doc = { _id: keys.length ? Object.fromEntries(keys.map((k) => [k.name, aggOf(k.expr, plain)])) : null }
  for (const a of accs) group[a.name] = a.op
  pipeline.push({ $group: group })
  const distinctCounts = accs.filter((a) => a.countDistinct)
  if (distinctCounts.length) pipeline.push({ $set: Object.fromEntries(distinctCounts.map((a) => [a.name, { $size: `$${a.name}` }])) })
  if (q.having) pipeline.push({ $match: filterOf(q.having, gctx) })

  const project: Doc = {}
  for (const o of outputs) {
    project[o.name] = aggOf(o.item.expr, gctx)
  }
  if (!('_id' in project)) project._id = 0
  const sortAfter = q.orderBy.some((o) => groupRef(ordinalItem(o.expr)?.expr ?? o.expr) === null)
  if (sortAfter) {
    pipeline.push({ $project: project })
    pipeline.push({ $sort: sortOnOutputs() })
    tail()
  } else {
    if (q.orderBy.length) pipeline.push({ $sort: Object.fromEntries(q.orderBy.map((o) => [groupRef(ordinalItem(o.expr)?.expr ?? o.expr)!, o.dir])) })
    tail()
    pipeline.push({ $project: project })
  }
  return { coll, kind: 'aggregate', pipeline }
}

/** Translate a SQL SELECT into a MongoDB find query or aggregation pipeline. Throws SqlError. */
export function sqlToMongo(sql: string): SqlTranslation {
  const q = new Parser(tokenize(sql)).statement()
  return translate(q, sql)
}

/** Ranges of the `;`-separated statements in a script (quotes and comments respected). */
export function splitSqlStatements(sql: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let start = 0
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c
      i++
      while (i < sql.length && !(sql[i] === close && sql[i + 1] !== close)) i += sql[i] === close ? 2 : 1
      i++
      continue
    }
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl
      continue
    }
    if (sql.startsWith('/*', i)) {
      const e = sql.indexOf('*/', i + 2)
      i = e < 0 ? sql.length : e + 2
      continue
    }
    if (c === ';') {
      out.push({ from: start, to: i })
      start = i + 1
    }
    i++
  }
  out.push({ from: start, to: sql.length })
  return out
}

const blankSql = (s: string): boolean => !s.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()

/** The statement under the cursor; a cursor just after `;` on the same line belongs to that statement. */
export function sqlStatementAt(sql: string, pos: number): { text: string; offset: number } {
  const all = splitSqlStatements(sql)
  let idx = all.findIndex((r) => pos >= r.from && pos <= r.to)
  if (idx < 0) idx = all.length - 1
  const lead = sql.slice(all[idx].from, pos)
  if (idx > 0 && !lead.includes('\n') && !lead.trim()) idx--
  if (blankSql(sql.slice(all[idx].from, all[idx].to))) {
    const before = all.slice(0, idx).reverse().find((r) => !blankSql(sql.slice(r.from, r.to)))
    const after = all.slice(idx + 1).find((r) => !blankSql(sql.slice(r.from, r.to)))
    const r = before ?? after
    if (r) return { text: sql.slice(r.from, r.to), offset: r.from }
  }
  return { text: sql.slice(all[idx].from, all[idx].to), offset: all[idx].from }
}

/** Collection names referenced in FROM / JOIN, best effort (for autocomplete and context). */
export function sqlTables(sql: string): string[] {
  try {
    const q = new Parser(tokenize(sql)).statement()
    return [q.from.name, ...q.joins.map((j) => j.table.name)]
  } catch {
    return []
  }
}
