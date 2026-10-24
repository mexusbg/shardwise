import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID
} from 'bson'
import { parseFilter } from 'mongodb-query-parser'
import type { Doc, JsonFlavor } from '@shared/api'

/*
 * Pure JSON formatting / parsing for import & export. No I/O here so everything is unit-testable.
 * BSON values are recognised by `_bsontype` (never `instanceof`, there can be two copies of `bson`).
 */

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const MAX_SAFE = Number.MAX_SAFE_INTEGER

type Bsonish = { _bsontype?: string }
const bsonType = (v: unknown): string | undefined =>
  v !== null && typeof v === 'object' ? (v as Bsonish)._bsontype : undefined

const isDate = (v: unknown): v is Date => v instanceof Date || Object.prototype.toString.call(v) === '[object Date]'
const isRegExp = (v: unknown): v is RegExp =>
  v instanceof RegExp || Object.prototype.toString.call(v) === '[object RegExp]'

function regexParts(v: unknown): { pattern: string; flags: string } {
  if (isRegExp(v)) return { pattern: v.source, flags: v.flags }
  const r = v as BSONRegExp
  return { pattern: r.pattern, flags: r.options }
}

function isUuidBinary(b: Binary): boolean {
  return b.sub_type === 4 && b.length() === 16
}

function uuidText(b: Binary): string {
  const hex = Buffer.from(b.buffer).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function binaryBase64(b: Binary): string {
  return Buffer.from(b.buffer.subarray(0, b.length())).toString('base64')
}

/** Double literal that re-parses as a Double (always has a `.` or exponent). */
export function doubleLiteral(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  if (Object.is(n, -0)) return '-0.0'
  const s = String(n)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

function isoOrNull(d: Date): string | null {
  const t = d.getTime()
  if (Number.isNaN(t)) return null
  const y = d.getUTCFullYear()
  return y >= 0 && y <= 9999 ? d.toISOString() : null
}

// ---------------------------------------------------------------------------
// Shell-style formatting (mongo shell syntax and the legacy mongo shell format)
// ---------------------------------------------------------------------------

type ShellStyle = 'shell' | 'legacyShell'

function escapeRegexLiteral(p: string): string {
  let out = ''
  let esc = false
  for (const ch of p) {
    if (esc) {
      out += ch
      esc = false
    } else if (ch === '\\') {
      out += ch
      esc = true
    } else if (ch === '/') out += '\\/'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\u2028') out += '\\u2028'
    else if (ch === '\u2029') out += '\\u2029'
    else out += ch
  }
  return out
}

function shellScalar(v: unknown, style: ShellStyle, nested: (x: unknown) => string): string | undefined {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v)
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      // A plain JS number is stored by the driver as Int32 when it is an int32-range integer, else Double.
      return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX && !Object.is(v, -0) ? `NumberInt(${v})` : doubleLiteral(v)
    case 'bigint':
      return `NumberLong(${JSON.stringify(v.toString())})`
  }
  if (isDate(v)) {
    const iso = isoOrNull(v)
    return iso ? `ISODate(${JSON.stringify(iso)})` : `new Date(${Number.isNaN(v.getTime()) ? 'NaN' : v.getTime()})`
  }
  if (isRegExp(v)) {
    const r = regexParts(v)
    return `/${escapeRegexLiteral(r.pattern)}/${r.flags}`
  }
  switch (bsonType(v)) {
    case 'ObjectId':
      return `ObjectId(${JSON.stringify((v as ObjectId).toHexString())})`
    case 'Int32':
      return `NumberInt(${(v as Int32).valueOf()})`
    case 'Double':
      return doubleLiteral((v as Double).valueOf())
    case 'Long': {
      const s = (v as Long).toString()
      if (style === 'legacyShell' && Math.abs(Number(s)) <= MAX_SAFE) return `NumberLong(${s})`
      return `NumberLong(${JSON.stringify(s)})`
    }
    case 'Decimal128':
      return `NumberDecimal(${JSON.stringify((v as Decimal128).toString())})`
    case 'Binary': {
      const b = v as Binary
      if (isUuidBinary(b)) return `UUID(${JSON.stringify(uuidText(b))})`
      return `BinData(${b.sub_type}, ${JSON.stringify(binaryBase64(b))})`
    }
    case 'BSONRegExp': {
      const r = regexParts(v)
      return `/${escapeRegexLiteral(r.pattern)}/${r.flags}`
    }
    case 'Timestamp': {
      const t = v as Timestamp
      return style === 'legacyShell' ? `Timestamp(${t.t}, ${t.i})` : `Timestamp({ t: ${t.t}, i: ${t.i} })`
    }
    case 'Code': {
      const c = v as Code
      return c.scope ? `Code(${JSON.stringify(c.code)}, ${nested(c.scope)})` : `Code(${JSON.stringify(c.code)})`
    }
    case 'DBRef': {
      const r = v as DBRef
      const args = [JSON.stringify(r.collection), nested(r.oid)]
      if (r.db) args.push(JSON.stringify(r.db))
      return `DBRef(${args.join(', ')})`
    }
    case 'MinKey':
      return 'MinKey()'
    case 'MaxKey':
      return 'MaxKey()'
    case 'BSONSymbol':
    case 'DBPointer':
      // No shell constructor; canonical EJSON is understood by our importer.
      return EJSON.stringify(v as never, { relaxed: false })
  }
  return undefined
}

function shellValue(v: unknown, style: ShellStyle, pretty: boolean, level: number): string {
  const nested = (x: unknown): string => shellValue(x, style, pretty, level)
  const scalar = shellScalar(v, style, nested)
  if (scalar !== undefined) return scalar
  const unit = style === 'legacyShell' ? '\t' : '  '
  const pad = pretty ? unit.repeat(level + 1) : ''
  const endPad = pretty ? unit.repeat(level) : ''
  const nl = pretty ? '\n' : ''
  const colon = style === 'legacyShell' ? ' : ' : ': '
  if (Array.isArray(v)) {
    if (!v.length) return style === 'legacyShell' ? '[ ]' : '[]'
    const items = v.map((x) => pad + shellValue(x, style, pretty, level + 1))
    if (!pretty) return style === 'legacyShell' ? `[ ${items.join(', ')} ]` : `[${items.join(', ')}]`
    return `[${nl}${items.join(`,${nl}`)}${nl}${endPad}]`
  }
  const entries = Object.entries(v as Doc)
  if (!entries.length) return style === 'legacyShell' ? '{ }' : '{}'
  const items = entries.map(([k, x]) => `${pad}${JSON.stringify(k)}${colon}${shellValue(x, style, pretty, level + 1)}`)
  if (!pretty) return style === 'legacyShell' ? `{ ${items.join(', ')} }` : `{${items.join(', ')}}`
  return `{${nl}${items.join(`,${nl}`)}${nl}${endPad}}`
}

// ---------------------------------------------------------------------------
// Pure JSON (no types)
// ---------------------------------------------------------------------------

function numberOrString(s: string): number | string {
  const n = Number(s)
  return Number.isFinite(n) && Math.abs(n) <= MAX_SAFE && String(n) === s.replace(/^\+/, '') ? n : s
}

/** Convert a BSON value to plain JSON data (ObjectId → hex, Date → ISO, numbers → numbers, …). */
export function toPure(v: unknown): unknown {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      return Number.isFinite(v) ? v : null
    case 'bigint':
      return numberOrString(v.toString())
  }
  if (isDate(v)) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (isRegExp(v)) {
    const r = regexParts(v)
    return `/${r.pattern}/${r.flags}`
  }
  if (Array.isArray(v)) return v.map(toPure)
  switch (bsonType(v)) {
    case 'ObjectId':
      return (v as ObjectId).toHexString()
    case 'Int32':
    case 'Double': {
      const n = (v as Double).valueOf()
      return Number.isFinite(n) ? n : null
    }
    case 'Long':
      return numberOrString((v as Long).toString())
    case 'Decimal128': {
      const s = (v as Decimal128).toString()
      const n = Number(s)
      return Number.isFinite(n) && Math.abs(n) <= MAX_SAFE && /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(s) && s.replace(/[-+.eE]/g, '').length <= 15
        ? n
        : s
    }
    case 'Binary': {
      const b = v as Binary
      return isUuidBinary(b) ? uuidText(b) : binaryBase64(b)
    }
    case 'BSONRegExp': {
      const r = regexParts(v)
      return `/${r.pattern}/${r.flags}`
    }
    case 'Timestamp': {
      const t = v as Timestamp
      return { t: t.t, i: t.i }
    }
    case 'Code': {
      const c = v as Code
      return c.scope ? { code: c.code, scope: toPure(c.scope) } : c.code
    }
    case 'DBRef': {
      const r = v as DBRef
      const o: Doc = { $ref: r.collection, $id: toPure(r.oid) }
      if (r.db) o.$db = r.db
      return o
    }
    case 'MinKey':
      return 'MinKey'
    case 'MaxKey':
      return 'MaxKey'
    case 'BSONSymbol':
      return (v as BSONSymbol).valueOf()
  }
  if (bsonType(v)) return EJSON.serialize(v as never, { relaxed: true })
  const out: Doc = {}
  for (const [k, x] of Object.entries(v as Doc)) out[k] = toPure(x)
  return out
}

// ---------------------------------------------------------------------------
// Public formatting API
// ---------------------------------------------------------------------------

/** Format one document in the given flavour. `pretty` indents with newlines. */
export function formatDoc(doc: Doc, flavor: JsonFlavor, pretty = false): string {
  switch (flavor) {
    case 'shell':
    case 'legacyShell':
      return shellValue(doc, flavor, pretty, 0)
    case 'canonical':
      return EJSON.stringify(doc as never, undefined, pretty ? 2 : undefined, { relaxed: false })
    case 'relaxed':
      return EJSON.stringify(doc as never, undefined, pretty ? 2 : undefined, { relaxed: true })
    case 'pure':
      return JSON.stringify(toPure(doc), null, pretty ? 2 : undefined)
  }
}

/** Incremental writer for the `lines` / `array` layouts. */
export class JsonLayout {
  private count = 0
  constructor(
    private flavor: JsonFlavor,
    private layout: 'lines' | 'array',
    private pretty: boolean
  ) {}

  /** Text that opens the file. */
  start(): string {
    return this.layout === 'array' ? '[' : ''
  }

  /** Text for the next document. */
  doc(d: Doc): string {
    let text = formatDoc(d, this.flavor, this.pretty)
    const first = this.count++ === 0
    if (this.layout === 'lines') return `${text}\n`
    if (this.pretty) text = text.replace(/\n/g, '\n  ')
    return `${first ? '\n' : ',\n'}${this.pretty ? '  ' : ''}${text}`
  }

  /** Text that closes the file. */
  end(): string {
    if (this.layout === 'lines') return ''
    return this.count ? '\n]\n' : ']\n'
  }
}

// ---------------------------------------------------------------------------
// Shell-syntax parser (strict superset of JSON)
// ---------------------------------------------------------------------------

export class ShellParseError extends Error {}

/** Keep only the regex options BSON supports (JS-only g / y / d are dropped), sorted. */
const bsonRegexFlags = (f: string): string => [...new Set(f)].filter((c) => 'ilmsux'.includes(c)).sort().join('')

const NUM_RE = /^[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/
const IDENT_RE = /^[A-Za-z_$][\w$]*/
/** Unquoted field names are JavaScript identifiers, which may be non-Latin (`{ име: 1 }`). */
const KEY_RE = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*/u

class NumLit {
  constructor(public text: string) {}
}

const EJSON_KEYS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$regex',
  '$timestamp',
  '$symbol',
  '$code',
  '$minKey',
  '$maxKey',
  '$undefined',
  '$dbPointer',
  '$ref'
])

function isJsonData(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return true
  if (Array.isArray(v)) return v.every(isJsonData)
  if (typeof v === 'object' && !bsonType(v) && !isDate(v) && !isRegExp(v)) return Object.values(v as Doc).every(isJsonData)
  return false
}

/** Turn a parsed number literal into the BSON value it stands for. */
export function numberValue(text: string): unknown {
  if (/[.eE]/.test(text)) return new Double(Number(text))
  const n = Number(text)
  if (n >= INT32_MIN && n <= INT32_MAX) return new Int32(n)
  try {
    const big = BigInt(text.replace(/^\+/, ''))
    if (big >= -(2n ** 63n) && big < 2n ** 63n) return Long.fromBigInt(big)
  } catch {
    /* fall through */
  }
  return new Double(n)
}

class ShellParser {
  private i = 0
  constructor(private s: string) {}

  fail(msg: string): never {
    const before = this.s.slice(0, this.i)
    const line = before.split('\n').length
    throw new ShellParseError(`${msg} at line ${line}, near '${this.s.slice(this.i, this.i + 20)}'`)
  }

  ws(): void {
    const s = this.s
    for (;;) {
      const c = s.charCodeAt(this.i)
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff || c === 0xa0) this.i++
      else if (c === 47 && s[this.i + 1] === '/') {
        const e = s.indexOf('\n', this.i)
        this.i = e < 0 ? s.length : e + 1
      } else if (c === 47 && s[this.i + 1] === '*') {
        const e = s.indexOf('*/', this.i + 2)
        if (e < 0) this.fail('Unterminated comment')
        this.i = e + 2
      } else return
    }
  }

  peek(): string {
    this.ws()
    return this.s[this.i] ?? ''
  }

  expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`Expected '${ch}'`)
    this.i++
  }

  eof(): boolean {
    return this.peek() === ''
  }

  string(): string {
    const q = this.s[this.i++]
    let out = ''
    for (;;) {
      const c = this.s[this.i++]
      if (c === undefined) this.fail('Unterminated string')
      if (c === q) return out
      if (c !== '\\') {
        out += c
        continue
      }
      const e = this.s[this.i++]
      switch (e) {
        case 'n':
          out += '\n'
          break
        case 't':
          out += '\t'
          break
        case 'r':
          out += '\r'
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case 'v':
          out += '\v'
          break
        case '0':
          out += '\0'
          break
        case 'u': {
          if (this.s[this.i] === '{') {
            const end = this.s.indexOf('}', this.i)
            out += String.fromCodePoint(parseInt(this.s.slice(this.i + 1, end), 16))
            this.i = end + 1
          } else {
            const h = this.s.slice(this.i, this.i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail('Bad \\u escape')
            out += String.fromCharCode(parseInt(h, 16))
            this.i += 4
          }
          break
        }
        case 'x': {
          const h = this.s.slice(this.i, this.i + 2)
          if (!/^[0-9a-fA-F]{2}$/.test(h)) this.fail('Bad \\x escape')
          out += String.fromCharCode(parseInt(h, 16))
          this.i += 2
          break
        }
        case '\r':
          if (this.s[this.i] === '\n') this.i++
          break
        case '\n':
          break
        case undefined:
          this.fail('Unterminated string')
          break
        default:
          out += e
      }
    }
  }

  regex(): BSONRegExp {
    // at '/'
    this.i++
    let pattern = ''
    let inClass = false
    for (;;) {
      const c = this.s[this.i++]
      if (c === undefined || c === '\n') this.fail('Unterminated regular expression')
      if (c === '\\') {
        // `\/` only exists because of the literal syntax; BSON stores the bare '/'.
        const nx = this.s[this.i++] ?? ''
        pattern += nx === '/' ? '/' : c + nx
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      pattern += c
    }
    const m = /^[a-z]*/.exec(this.s.slice(this.i))!
    this.i += m[0].length
    return new BSONRegExp(pattern, bsonRegexFlags(m[0]))
  }

  key(): string {
    const c = this.peek()
    if (c === '"' || c === "'") return this.string()
    const m = KEY_RE.exec(this.s.slice(this.i, this.i + 1024)) ?? /^\d+/.exec(this.s.slice(this.i, this.i + 64))
    if (!m) this.fail('Expected a field name')
    this.i += m[0].length
    return m[0]
  }

  object(): unknown {
    this.expect('{')
    const out: Doc = {}
    if (this.peek() === '}') {
      this.i++
      return this.postObject(out)
    }
    for (;;) {
      if (this.peek() === '}') {
        this.i++
        break
      }
      const k = this.key()
      this.expect(':')
      out[k] = this.value()
      const c = this.peek()
      if (c === ',') {
        this.i++
        continue
      }
      if (c === '}') {
        this.i++
        break
      }
      this.fail("Expected ',' or '}'")
    }
    return this.postObject(out)
  }

  /** `{ "$oid": … }` and friends: extended JSON embedded in shell syntax. */
  postObject(o: Doc): unknown {
    const keys = Object.keys(o)
    if (keys.length && keys.length <= 3 && keys.some((k) => EJSON_KEYS.has(k)) && isJsonData(o)) {
      try {
        return EJSON.deserialize(o, { relaxed: false })
      } catch {
        return o
      }
    }
    return o
  }

  array(): unknown[] {
    this.expect('[')
    const out: unknown[] = []
    for (;;) {
      if (this.peek() === ']') {
        this.i++
        break
      }
      out.push(this.value())
      const c = this.peek()
      if (c === ',') {
        this.i++
        continue
      }
      if (c === ']') {
        this.i++
        break
      }
      this.fail("Expected ',' or ']'")
    }
    return out
  }

  args(): unknown[] {
    this.expect('(')
    const out: unknown[] = []
    for (;;) {
      if (this.peek() === ')') {
        this.i++
        break
      }
      out.push(this.value(true))
      const c = this.peek()
      if (c === ',') {
        this.i++
        continue
      }
      if (c === ')') {
        this.i++
        break
      }
      this.fail("Expected ',' or ')'")
    }
    return out
  }

  value(raw = false): unknown {
    const c = this.peek()
    if (c === '{') return this.object()
    if (c === '[') return this.array()
    if (c === '"' || c === "'") return this.string()
    if (c === '/') return this.regex()
    const rest = this.s.slice(this.i, this.i + 400)
    if (/^[-+]?Infinity\b/.test(rest)) {
      const neg = rest[0] === '-'
      this.i += rest[0] === '-' || rest[0] === '+' ? 9 : 8
      return raw ? new NumLit(neg ? '-Infinity' : 'Infinity') : new Double(neg ? -Infinity : Infinity)
    }
    const num = NUM_RE.exec(rest)
    if (num && /^[-+]?[.\d]/.test(rest)) {
      this.i += num[0].length
      return raw ? new NumLit(num[0]) : numberValue(num[0])
    }
    const id = IDENT_RE.exec(rest)
    if (!id) this.fail('Unexpected character')
    this.i += id[0].length
    let name = id[0]
    switch (name) {
      case 'true':
        return true
      case 'false':
        return false
      case 'null':
        return null
      case 'undefined':
        return undefined
      case 'NaN':
        return raw ? new NumLit('NaN') : new Double(NaN)
      case 'new':
        this.ws()
        name = IDENT_RE.exec(this.s.slice(this.i, this.i + 64))?.[0] ?? this.fail('Expected a constructor')
        this.i += name.length
        break
      case 'MinKey':
      case 'MaxKey':
        if (this.peek() !== '(') return name === 'MinKey' ? new MinKey() : new MaxKey()
    }
    if (this.peek() !== '(') this.fail(`Unknown identifier '${name}'`)
    return this.call(name, this.args())
  }

  call(name: string, args: unknown[]): unknown {
    const text = (i: number): string => {
      const a = args[i]
      if (a instanceof NumLit) return a.text
      if (typeof a === 'string') return a
      if (a === undefined) this.fail(`${name}() expects an argument`)
      return String(a)
    }
    const num = (i: number): number => Number(text(i))
    try {
      switch (name) {
        case 'ObjectId':
        case 'ObjectID':
          return args.length ? new ObjectId(text(0)) : new ObjectId()
        case 'ISODate':
        case 'Date': {
          if (!args.length) return new Date()
          if (args.length > 1) {
            const p = args.map((_, i) => num(i))
            return new Date(Date.UTC(p[0], p[1] ?? 0, p[2] ?? 1, p[3] ?? 0, p[4] ?? 0, p[5] ?? 0, p[6] ?? 0))
          }
          const a = args[0]
          if (a instanceof NumLit) return new Date(Number(a.text))
          // Some shell-style exporters write offsets as +0000; Date() wants +00:00.
          const d = new Date(text(0).replace(/(T[\d:.]+)([+-]\d{2})(\d{2})$/, '$1$2:$3'))
          if (Number.isNaN(d.getTime())) this.fail(`Invalid date '${text(0)}'`)
          return d
        }
        case 'NumberInt':
        case 'Int32':
          return new Int32(num(0))
        case 'NumberLong':
        case 'Long':
          return Long.fromString(text(0).replace(/^\+/, '').replace(/\.0*$/, ''))
        case 'NumberDecimal':
        case 'Decimal128':
          return Decimal128.fromString(text(0))
        case 'Double':
        case 'Number':
          return new Double(num(0))
        case 'BinData':
          return new Binary(Buffer.from(text(1), 'base64'), num(0))
        case 'HexData':
          return new Binary(Buffer.from(text(1), 'hex'), num(0))
        case 'UUID':
          return args.length ? new UUID(text(0)).toBinary() : new UUID().toBinary()
        case 'MD5':
          return new Binary(Buffer.from(text(0), 'hex'), 5)
        case 'Timestamp': {
          const a = args[0]
          if (a && typeof a === 'object' && !(a instanceof NumLit)) {
            const o = a as { t?: unknown; i?: unknown }
            return new Timestamp({ t: Number(String(o.t?.valueOf())), i: Number(String(o.i?.valueOf())) })
          }
          return new Timestamp({ t: args.length ? num(0) : 0, i: args.length > 1 ? num(1) : 0 })
        }
        case 'RegExp':
        case 'BSONRegExp':
          return new BSONRegExp(text(0), bsonRegexFlags(args.length > 1 ? text(1) : ''))
        case 'Code':
          return new Code(text(0), (args[1] as Doc | undefined) ?? null)
        case 'DBRef':
          return new DBRef(text(0), args[1] as ObjectId, args.length > 2 ? text(2) : undefined)
        case 'MinKey':
          return new MinKey()
        case 'MaxKey':
          return new MaxKey()
        case 'Symbol':
        case 'BSONSymbol':
          return new BSONSymbol(text(0))
      }
    } catch (e) {
      if (e instanceof ShellParseError) throw e
      this.fail(`${name}(): ${(e as Error).message}`)
    }
    this.fail(`Unsupported function '${name}'`)
  }
}

/** Parse one document written in mongo shell syntax (also accepts JSON / EJSON). */
export function parseShellDoc(text: string): Doc {
  const p = new ShellParser(text)
  if (p.peek() !== '{') p.fail("Expected '{'")
  const v = p.value()
  if (!p.eof()) p.fail('Unexpected text after the document')
  if (v === null || typeof v !== 'object' || Array.isArray(v) || bsonType(v)) throw new ShellParseError('Not a document')
  return v as Doc
}

export type DocSyntax = 'ejson' | 'shell'

/**
 * Parse one document of unknown flavour: (E)JSON first (canonical, relaxed, legacy, pure — numbers stay
 * Int32 / Long / Double), then mongo-shell syntax, then mongodb-query-parser as a last resort.
 * `prefer` lets callers stick with the syntax that worked for the previous document.
 */
export function parseDocText(text: string, prefer: DocSyntax = 'ejson'): { doc: Doc; syntax: DocSyntax } {
  const ejson = (): Doc => {
    const v = EJSON.parse(text, { relaxed: false }) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ShellParseError('Not a document')
    return v as Doc
  }
  if (prefer === 'ejson') {
    try {
      return { doc: ejson(), syntax: 'ejson' }
    } catch {
      /* try shell */
    }
  }
  try {
    return { doc: parseShellDoc(text), syntax: 'shell' }
  } catch (shellErr) {
    if (prefer === 'shell') {
      try {
        return { doc: ejson(), syntax: 'ejson' }
      } catch {
        /* fall through */
      }
    }
    try {
      const v = parseFilter(text) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return { doc: v as Doc, syntax: 'shell' }
    } catch {
      /* report the shell parser's error, it is the most precise */
    }
    throw shellErr
  }
}

// ---------------------------------------------------------------------------
// Streaming document splitter
// ---------------------------------------------------------------------------

export interface SplitDoc {
  text: string
  /** 1-based line where the document starts. */
  line: number
}

const enum St {
  Normal,
  Str,
  Regex,
  RegexClass,
  LineComment,
  BlockComment
}

/**
 * Splits a stream of text into top-level documents without parsing them. Handles a JSON array of
 * documents, one document per line, pretty-printed or concatenated documents. Tracks brace depth outside
 * strings, regex literals and comments, so the input never has to be held in memory as a whole.
 */
export class DocSplitter {
  private parts: string[] = []
  private depth = 0
  private st = St.Normal
  private quote = 0
  private escape = false
  private pendingSlash = false
  private prevSig = 0
  private inArray = false
  private inDoc = false
  private line = 1
  private docLine = 0
  private started = false

  /** Feed a chunk; returns the documents completed by it. */
  push(chunk: string): SplitDoc[] {
    const out: SplitDoc[] = []
    let start = this.inDoc ? 0 : -1
    let i = 0
    if (!this.started && chunk.length) {
      if (chunk.charCodeAt(0) === 0xfeff) i = 1
      this.started = true
    }
    const n = chunk.length
    for (; i < n; i++) {
      const c = chunk.charCodeAt(i)
      if (c === 10) this.line++
      switch (this.st) {
        case St.Str:
          if (this.escape) this.escape = false
          else if (c === 92) this.escape = true
          else if (c === this.quote) this.st = St.Normal
          continue
        case St.Regex:
          if (this.escape) this.escape = false
          else if (c === 92) this.escape = true
          else if (c === 91) this.st = St.RegexClass
          else if (c === 47) this.st = St.Normal
          else if (c === 10) this.fail('Unterminated regular expression')
          continue
        case St.RegexClass:
          if (this.escape) this.escape = false
          else if (c === 92) this.escape = true
          else if (c === 93) this.st = St.Regex
          continue
        case St.LineComment:
          if (c === 10) this.st = St.Normal
          continue
        case St.BlockComment:
          if (c === 47 && this.prevSig === 42) {
            this.st = St.Normal
            this.prevSig = 0
          } else this.prevSig = c
          continue
      }
      // Normal state
      if (this.pendingSlash) {
        this.pendingSlash = false
        if (c === 47) {
          this.st = St.LineComment
          continue
        }
        if (c === 42) {
          this.st = St.BlockComment
          this.prevSig = 0
          continue
        }
        // A regex literal: re-process this char inside the regex state.
        this.st = St.Regex
        i--
        if (c === 10) this.line--
        continue
      }
      if (c === 32 || c === 9 || c === 10 || c === 13) continue
      if (c === 34 || c === 39) {
        if (!this.inDoc) this.fail('Unexpected string outside a document')
        this.st = St.Str
        this.quote = c
        this.prevSig = c
        continue
      }
      if (c === 47) {
        this.pendingSlash = true
        continue
      }
      const base = this.inArray ? 1 : 0
      if (c === 123 || c === 91 || c === 40) {
        if (!this.inDoc) {
          if (c === 91 && this.depth === 0 && !this.inArray) {
            this.inArray = true
            this.depth = 1
            this.prevSig = c
            continue
          }
          if (c !== 123 || this.depth !== base) this.fail(`Unexpected '${String.fromCharCode(c)}'`)
          this.inDoc = true
          this.docLine = this.line
          start = i
        }
        this.depth++
      } else if (c === 125 || c === 93 || c === 41) {
        if (!this.inDoc) {
          if (c === 93 && this.inArray && this.depth === 1) {
            this.inArray = false
            this.depth = 0
            this.prevSig = c
            continue
          }
          this.fail(`Unexpected '${String.fromCharCode(c)}'`)
        }
        this.depth--
        if (this.depth === base) {
          this.parts.push(chunk.slice(start, i + 1))
          out.push({ text: this.parts.join(''), line: this.docLine })
          this.parts = []
          this.inDoc = false
          start = -1
        }
      } else if (!this.inDoc && c !== 44) {
        this.fail(`Unexpected '${String.fromCharCode(c)}' outside a document`)
      }
      // A '/' after one of these starts a regex literal rather than being a division (no division in data).
      this.prevSig = c
    }
    if (this.inDoc && start >= 0) this.parts.push(chunk.slice(start))
    return out
  }

  /** Call at end of input; throws if a document was left open. */
  end(): void {
    if (this.inDoc || this.st === St.Str || this.st === St.Regex) this.fail(`Unexpected end of file (document starting at line ${this.docLine} is incomplete)`)
    if (this.inArray) this.fail("Unexpected end of file (missing ']')")
  }

  private fail(msg: string): never {
    throw new ShellParseError(`${msg} at line ${this.line}`)
  }
}

/** Convenience: split a whole string. */
export function splitDocs(text: string): SplitDoc[] {
  const s = new DocSplitter()
  const out = s.push(text)
  s.end()
  return out
}
