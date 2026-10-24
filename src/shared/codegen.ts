import { bsonTypeOf, isPlainDoc } from './bsonValue'

type Doc = Record<string, unknown>

export const CODE_LANGUAGES = ['mongosh', 'node', 'mongoose', 'python', 'java', 'csharp', 'go', 'php', 'ruby'] as const
export type CodeLanguage = (typeof CODE_LANGUAGES)[number]

export const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  mongosh: 'mongo shell',
  node: 'Node.js',
  mongoose: 'Mongoose',
  python: 'Python (PyMongo)',
  java: 'Java',
  csharp: 'C#',
  go: 'Go',
  php: 'PHP',
  ruby: 'Ruby'
}

export type CodeQuery =
  | { kind: 'find'; db: string; coll: string; filter: Doc; projection?: Doc | null; sort?: Doc | null; skip?: number; limit?: number; collation?: Doc | null }
  | { kind: 'aggregate'; db: string; coll: string; pipeline: Doc[]; collation?: Doc | null }

interface Lang {
  str: (s: string) => string
  /** Render a non-container BSON value. */
  scalar: (v: unknown, t: ReturnType<typeof bsonTypeOf>) => string
  obj: (pairs: [string, string][], multiline: boolean, ind: string) => string
  arr: (items: string[], multiline: boolean, ind: string) => string
}

const IND = '  '
const MAX_FLAT = 72

function render(v: unknown, lang: Lang, depth = 0): string {
  const ind = IND.repeat(depth)
  if (isPlainDoc(v)) {
    const pairs = Object.entries(v).map(([k, x]) => [k, render(x, lang, depth + 1)] as [string, string])
    const flat = lang.obj(pairs, false, ind)
    return flat.length <= MAX_FLAT && !flat.includes('\n') ? flat : lang.obj(pairs, true, ind)
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => render(x, lang, depth + 1))
    const flat = lang.arr(items, false, ind)
    return flat.length <= MAX_FLAT && !flat.includes('\n') ? flat : lang.arr(items, true, ind)
  }
  return lang.scalar(v, bsonTypeOf(v))
}

/**
 * Single-quoted literal for JavaScript / Python (UTF-8 sources: non-ASCII text such as Cyrillic stays as is).
 * Line breaks must be escaped there.
 */
const sq = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
/** Single-quoted literal for PHP / Ruby, which only know `\\` and `\'` there: `\n` would stay two characters, a raw line break is fine. */
const sqRaw = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const dq = (s: string): string => JSON.stringify(s)

const num = (v: unknown): string => {
  const n = Number((v as { valueOf(): unknown }).valueOf())
  return Number.isFinite(n) ? String(n) : 'NaN'
}
const dbl = (v: unknown): string => {
  const s = num(v)
  return /^-?\d+$/.test(s) ? `${s}.0` : s
}
const iso = (v: unknown): string => (v as Date).toISOString()
const ms = (v: unknown): number => (v as Date).getTime()
const oidHex = (v: unknown): string => (v as { toHexString(): string }).toHexString()
const regex = (v: unknown): [string, string] => {
  if (v instanceof RegExp) return [v.source, v.flags]
  const r = v as { pattern: string; options: string }
  return [r.pattern, r.options]
}

const block = (open: string, close: string, items: string[], multiline: boolean, ind: string, sep = ', '): string => {
  if (!items.length) return `${open}${close}`
  if (!multiline) return `${open}${items.join(sep)}${close}`
  return `${open}\n${items.map((i) => `${ind}${IND}${i}`).join(`${sep.trim()}\n`)}\n${ind}${close}`
}

const jsKey = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : sq(k))

/** JavaScript (mongosh / Node / Mongoose) value syntax. */
function jsLang(shell: boolean): Lang {
  return {
    str: sq,
    scalar: (v, t) => {
      switch (t) {
        case 'string':
          return sq(v as string)
        case 'bool':
          return String(v)
        case 'null':
          return 'null'
        case 'int':
        case 'double':
          return num(v)
        case 'long':
          return shell ? `NumberLong(${sq(String(v))})` : `Long.fromString(${sq(String(v))})`
        case 'decimal':
          return shell ? `NumberDecimal(${sq(String(v))})` : `Decimal128.fromString(${sq(String(v))})`
        case 'date':
          return shell ? `ISODate(${sq(iso(v))})` : `new Date(${sq(iso(v))})`
        case 'objectId':
          return shell ? `ObjectId(${sq(oidHex(v))})` : `new ObjectId(${sq(oidHex(v))})`
        case 'regex': {
          const [p, o] = regex(v)
          return `/${p.replace(/\//g, '\\/')}/${o}`
        }
        default:
          return sq(String(v))
      }
    },
    obj: (pairs, ml, ind) => block('{ ', ' }', pairs.map(([k, v]) => `${jsKey(k)}: ${v}`), ml, ind).replace(/^\{ \n/, '{\n').replace(/\n(\s*) \}$/, '\n$1}'),
    arr: (items, ml, ind) => block('[', ']', items, ml, ind)
  }
}

const pyLang: Lang = {
  str: sq,
  scalar: (v, t) => {
    switch (t) {
      case 'string':
        return sq(v as string)
      case 'bool':
        return v ? 'True' : 'False'
      case 'null':
        return 'None'
      case 'int':
        return num(v)
      case 'double':
        return dbl(v)
      case 'long':
        return `Int64(${String(v)})`
      case 'decimal':
        return `Decimal128(${sq(String(v))})`
      case 'date':
        return `datetime.fromisoformat(${sq(iso(v).replace('Z', '+00:00'))})`
      case 'objectId':
        return `ObjectId(${sq(oidHex(v))})`
      case 'regex': {
        const [p, o] = regex(v)
        return `Regex(${sq(p)}, ${sq(o)})`
      }
      default:
        return sq(String(v))
    }
  },
  obj: (pairs, ml, ind) => block('{', '}', pairs.map(([k, v]) => `${sq(k)}: ${v}`), ml, ind),
  arr: (items, ml, ind) => block('[', ']', items, ml, ind)
}

const javaLang: Lang = {
  str: dq,
  scalar: (v, t) => {
    switch (t) {
      case 'string':
        return dq(v as string)
      case 'bool':
        return String(v)
      case 'null':
        return 'null'
      case 'int':
        return num(v)
      case 'double':
        return dbl(v)
      case 'long':
        return `${String(v)}L`
      case 'decimal':
        return `Decimal128.parse(${dq(String(v))})`
      case 'date':
        return `Date.from(Instant.parse(${dq(iso(v))}))`
      case 'objectId':
        return `new ObjectId(${dq(oidHex(v))})`
      case 'regex': {
        const [p, o] = regex(v)
        return `new BsonRegularExpression(${dq(p)}, ${dq(o)})`
      }
      default:
        return dq(String(v))
    }
  },
  obj: (pairs, ml, ind) => {
    if (!pairs.length) return 'new Document()'
    const [first, ...rest] = pairs
    const head = `new Document(${dq(first[0])}, ${first[1]})`
    if (!ml) return head + rest.map(([k, v]) => `.append(${dq(k)}, ${v})`).join('')
    return head + rest.map(([k, v]) => `\n${ind}${IND}.append(${dq(k)}, ${v})`).join('')
  },
  arr: (items, ml, ind) => block('Arrays.asList(', ')', items, ml, ind)
}

const csLang: Lang = {
  str: dq,
  scalar: (v, t) => {
    switch (t) {
      case 'string':
        return dq(v as string)
      case 'bool':
        return String(v)
      case 'null':
        return 'BsonNull.Value'
      case 'int':
        return num(v)
      case 'double':
        return dbl(v)
      case 'long':
        return `${String(v)}L`
      case 'decimal':
        return `Decimal128.Parse(${dq(String(v))})`
      case 'date':
        return `new BsonDateTime(DateTime.Parse(${dq(iso(v))}, null, DateTimeStyles.RoundtripKind))`
      case 'objectId':
        return `new ObjectId(${dq(oidHex(v))})`
      case 'regex': {
        const [p, o] = regex(v)
        return `new BsonRegularExpression(${dq(p)}, ${dq(o)})`
      }
      default:
        return dq(String(v))
    }
  },
  obj: (pairs, ml, ind) => block('new BsonDocument { ', ' }', pairs.map(([k, v]) => `{ ${dq(k)}, ${v} }`), ml, ind).replace(/\{ \n/, '{\n').replace(/\n(\s*) \}$/, '\n$1}'),
  arr: (items, ml, ind) => block('new BsonArray { ', ' }', items, ml, ind).replace(/\{ \n/, '{\n').replace(/\n(\s*) \}$/, '\n$1}')
}

const goLang: Lang = {
  str: dq,
  scalar: (v, t) => {
    switch (t) {
      case 'string':
        return dq(v as string)
      case 'bool':
        return String(v)
      case 'null':
        return 'nil'
      case 'int':
        return `int32(${num(v)})`
      case 'double':
        return dbl(v)
      case 'long':
        return `int64(${String(v)})`
      case 'decimal':
        return `mustDecimal(${dq(String(v))})`
      case 'date':
        return `bson.DateTime(${ms(v)}) /* ${iso(v)} */`
      case 'objectId':
        return `mustObjectID(${dq(oidHex(v))})`
      case 'regex': {
        const [p, o] = regex(v)
        return `bson.Regex{Pattern: ${dq(p)}, Options: ${dq(o)}}`
      }
      default:
        return dq(String(v))
    }
  },
  obj: (pairs, ml, ind) => block('bson.D{', '}', pairs.map(([k, v]) => `{Key: ${dq(k)}, Value: ${v}}`), ml, ind, ml ? ', ' : ', ').replace(/(\n\s*)\}$/, ',$1}'),
  arr: (items, ml, ind) => block('bson.A{', '}', items, ml, ind).replace(/(\n\s*)\}$/, ',$1}')
}

const phpLang: Lang = {
  str: sqRaw,
  scalar: (v, t) => {
    switch (t) {
      case 'string':
        return sqRaw(v as string)
      case 'bool':
        return String(v)
      case 'null':
        return 'null'
      case 'int':
      case 'long':
        return String(v)
      case 'double':
        return dbl(v)
      case 'decimal':
        return `new MongoDB\\BSON\\Decimal128(${sqRaw(String(v))})`
      case 'date':
        return `new MongoDB\\BSON\\UTCDateTime(${ms(v)})`
      case 'objectId':
        return `new MongoDB\\BSON\\ObjectId(${sqRaw(oidHex(v))})`
      case 'regex': {
        const [p, o] = regex(v)
        return `new MongoDB\\BSON\\Regex(${sqRaw(p)}, ${sqRaw(o)})`
      }
      default:
        return sqRaw(String(v))
    }
  },
  obj: (pairs, ml, ind) => block('[', ']', pairs.map(([k, v]) => `${sqRaw(k)} => ${v}`), ml, ind),
  arr: (items, ml, ind) => block('[', ']', items, ml, ind)
}

const rubyLang: Lang = {
  str: sqRaw,
  scalar: (v, t) => {
    switch (t) {
      case 'string':
        return sqRaw(v as string)
      case 'bool':
        return String(v)
      case 'null':
        return 'nil'
      case 'int':
      case 'long':
        return String(v)
      case 'double':
        return dbl(v)
      case 'decimal':
        return `BSON::Decimal128.new(${sqRaw(String(v))})`
      case 'date':
        return `Time.iso8601(${sqRaw(iso(v))})`
      case 'objectId':
        return `BSON::ObjectId(${sqRaw(oidHex(v))})`
      case 'regex': {
        const [p, o] = regex(v)
        return `BSON::Regexp::Raw.new(${sqRaw(p)}, ${sqRaw(o)})`
      }
      default:
        return sqRaw(String(v))
    }
  },
  obj: (pairs, ml, ind) => block('{ ', ' }', pairs.map(([k, v]) => `${sqRaw(k)} => ${v}`), ml, ind).replace(/^\{ \n/, '{\n').replace(/\n(\s*) \}$/, '\n$1}'),
  arr: (items, ml, ind) => block('[', ']', items, ml, ind)
}

const has = (d?: Doc | null): d is Doc => !!d && Object.keys(d).length > 0

/** Variable assignments that the generated snippets refer to, rendered per language. */
function body(q: CodeQuery, lang: Lang): { filter: string; projection?: string; sort?: string; pipeline?: string } {
  if (q.kind === 'aggregate') return { filter: '', pipeline: render(q.pipeline, lang) }
  return { filter: render(q.filter, lang), projection: has(q.projection) ? render(q.projection, lang) : undefined, sort: has(q.sort) ? render(q.sort, lang) : undefined }
}

const JAVA_STRENGTH = ['PRIMARY', 'SECONDARY', 'TERTIARY', 'QUATERNARY', 'IDENTICAL']
const CS_STRENGTH = ['Primary', 'Secondary', 'Tertiary', 'Quaternary', 'Identical']
const upperSnake = (s: string): string => s.replace(/-/g, '_').toUpperCase()
const pascal = (s: string): string => s.replace(/(^|-)(\w)/g, (_m: string, _d: string, c: string) => c.toUpperCase())

/** `Collation.builder()...build()` (com.mongodb.client.model). */
function javaCollation(c: Doc): string {
  const calls: string[] = []
  for (const [k, v] of Object.entries(c)) {
    if (k === 'locale') calls.push(`.locale(${dq(String(v))})`)
    else if (k === 'strength') calls.push(`.collationStrength(CollationStrength.${JAVA_STRENGTH[Number(v) - 1] ?? 'TERTIARY'})`)
    else if (k === 'caseFirst') calls.push(`.collationCaseFirst(CollationCaseFirst.${upperSnake(String(v))})`)
    else if (k === 'alternate') calls.push(`.collationAlternate(CollationAlternate.${upperSnake(String(v))})`)
    else if (k === 'maxVariable') calls.push(`.collationMaxVariable(CollationMaxVariable.${upperSnake(String(v))})`)
    else calls.push(`.${k}(${String(v)})`)
  }
  return `Collation.builder()${calls.join('')}.build()`
}

/** `new Collation("bg", strength: ...)` (MongoDB.Driver). */
function csCollation(c: Doc): string {
  const args = [dq(String(c.locale))]
  for (const [k, v] of Object.entries(c)) {
    if (k === 'locale') continue
    if (k === 'strength') args.push(`strength: CollationStrength.${CS_STRENGTH[Number(v) - 1] ?? 'Tertiary'}`)
    else if (k === 'caseFirst') args.push(`caseFirst: CollationCaseFirst.${pascal(String(v))}`)
    else if (k === 'alternate') args.push(`alternate: CollationAlternate.${pascal(String(v))}`)
    else if (k === 'maxVariable') args.push(`maxVariable: CollationMaxVariable.${v === 'punct' ? 'Punctuation' : 'Space'}`)
    else args.push(`${k}: ${String(v)}`)
  }
  return `new Collation(${args.join(', ')})`
}

/** `&options.Collation{...}` (Go driver v2). */
function goCollation(c: Doc): string {
  const fields = Object.entries(c).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${typeof v === 'string' ? dq(v) : String(v)}`)
  return `&options.Collation{${fields.join(', ')}}`
}

/** Ruby hash with symbol keys: `{ locale: 'bg', strength: 2 }`. */
function rubyCollation(c: Doc): string {
  return `{ ${Object.entries(c)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? sqRaw(v) : String(v)}`)
    .join(', ')} }`
}

/** PascalCase model name; letters of any script (`клиенти` → `Клиенти`), separators dropped. */
export const modelName = (coll: string): string => {
  const base = coll
    .replace(/[^\p{L}\p{N}]+(.)?/gu, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/s$/, '')
  if (!base) return 'Model'
  const name = base[0].toUpperCase() + base.slice(1)
  return /^\p{L}/u.test(name) ? name : `Model${name}`
}

export function generateCode(q: CodeQuery, language: CodeLanguage): string {
  const skip = q.kind === 'find' && q.skip ? q.skip : 0
  const limit = q.kind === 'find' && q.limit ? q.limit : 0
  const colDoc = has(q.collation) ? q.collation : null
  switch (language) {
    case 'mongosh': {
      const b = body(q, jsLang(true))
      const target = /^[A-Za-z_$][\w$]*$/.test(q.coll) ? `db.${q.coll}` : `db.getCollection(${sq(q.coll)})`
      const head = `use(${sq(q.db)})\n\n`
      const c = colDoc && render(colDoc, jsLang(true))
      if (q.kind === 'aggregate') return `${head}${target}.aggregate(${b.pipeline}${c ? `, { collation: ${c} }` : ''})`
      return `${head}${target}.find(${b.filter}${b.projection ? `, ${b.projection}` : ''})${c ? `\n  .collation(${c})` : ''}${b.sort ? `\n  .sort(${b.sort})` : ''}${skip ? `\n  .skip(${skip})` : ''}${limit ? `\n  .limit(${limit})` : ''}`
    }
    case 'node': {
      const b = body(q, jsLang(false))
      const imports = `const { MongoClient, ObjectId, Long, Decimal128 } = require('mongodb')\n\nconst client = new MongoClient(process.env.MONGODB_URI)\nconst coll = client.db(${sq(q.db)}).collection(${sq(q.coll)})\n\n`
      const c = colDoc && render(colDoc, jsLang(false))
      if (q.kind === 'aggregate') return `${imports}const pipeline = ${b.pipeline}\n\nconst docs = await coll.aggregate(pipeline${c ? `, { collation: ${c} }` : ''}).toArray()`
      const opts = [b.projection && `projection: ${b.projection}`, b.sort && `sort: ${b.sort}`, skip && `skip: ${skip}`, limit && `limit: ${limit}`, c && `collation: ${c}`].filter(Boolean)
      return `${imports}const filter = ${b.filter}\n${opts.length ? `const options = { ${opts.join(', ')} }\n\nconst docs = await coll.find(filter, options).toArray()` : `\nconst docs = await coll.find(filter).toArray()`}`
    }
    case 'mongoose': {
      const b = body(q, jsLang(false))
      const m = modelName(q.coll)
      const head = `const mongoose = require('mongoose')\nconst { ObjectId } = mongoose.Types\n\nconst ${m} = mongoose.model(${sq(m)}, new mongoose.Schema({}, { strict: false }), ${sq(q.coll)})\n\n`
      const c = colDoc && render(colDoc, jsLang(false))
      if (q.kind === 'aggregate') return `${head}const docs = await ${m}.aggregate(${b.pipeline})${c ? `\n  .collation(${c})` : ''}`
      return `${head}const docs = await ${m}.find(${b.filter}${b.projection ? `, ${b.projection}` : ''})${c ? `\n  .collation(${c})` : ''}${b.sort ? `\n  .sort(${b.sort})` : ''}${skip ? `\n  .skip(${skip})` : ''}${limit ? `\n  .limit(${limit})` : ''}\n  .lean()`
    }
    case 'python': {
      const b = body(q, pyLang)
      const head = `from datetime import datetime\nfrom bson import ObjectId, Int64, Decimal128, Regex\nfrom pymongo import MongoClient\n\nclient = MongoClient(os.environ['MONGODB_URI'])\ncoll = client[${sq(q.db)}][${sq(q.coll)}]\n\n`.replace('from datetime', 'import os\nfrom datetime')
      const c = colDoc && render(colDoc, pyLang)
      if (q.kind === 'aggregate') return `${head}pipeline = ${b.pipeline}\n\ndocs = list(coll.aggregate(pipeline${c ? `, collation=${c}` : ''}))`
      const sortList = q.sort && has(q.sort) ? `[${Object.entries(q.sort).map(([k, v]) => `(${sq(k)}, ${Number((v as { valueOf(): unknown }).valueOf()) < 0 ? -1 : 1})`).join(', ')}]` : ''
      return `${head}filter = ${b.filter}\n${b.projection ? `projection = ${b.projection}\n` : ''}\ncursor = coll.find(filter${b.projection ? ', projection' : ''})${c ? `.collation(${c})` : ''}${sortList ? `.sort(${sortList})` : ''}${skip ? `.skip(${skip})` : ''}${limit ? `.limit(${limit})` : ''}\ndocs = list(cursor)`
    }
    case 'java': {
      const b = body(q, javaLang)
      const c = colDoc && javaCollation(colDoc)
      const cDecl = c ? `Collation collation = ${c};\n` : ''
      const head = `import com.mongodb.client.*;\n${c ? 'import com.mongodb.client.model.*;\n' : ''}import org.bson.Document;\nimport org.bson.BsonRegularExpression;\nimport org.bson.types.*;\nimport java.time.Instant;\nimport java.util.*;\n\nMongoClient client = MongoClients.create(System.getenv("MONGODB_URI"));\nMongoCollection<Document> coll = client.getDatabase(${dq(q.db)}).getCollection(${dq(q.coll)});\n\n`
      if (q.kind === 'aggregate') return `${head}List<Document> pipeline = ${b.pipeline};\n${cDecl}\nList<Document> docs = coll.aggregate(pipeline)${c ? '\n    .collation(collation)' : ''}.into(new ArrayList<>());`
      return `${head}Document filter = ${b.filter};\n${b.projection ? `Document projection = ${b.projection};\n` : ''}${b.sort ? `Document sort = ${b.sort};\n` : ''}${cDecl}\nList<Document> docs = coll.find(filter)${b.projection ? '\n    .projection(projection)' : ''}${c ? '\n    .collation(collation)' : ''}${b.sort ? '\n    .sort(sort)' : ''}${skip ? `\n    .skip(${skip})` : ''}${limit ? `\n    .limit(${limit})` : ''}\n    .into(new ArrayList<>());`
    }
    case 'csharp': {
      const b = body(q, csLang)
      const head = `using System.Globalization;\nusing MongoDB.Bson;\nusing MongoDB.Driver;\n\nvar client = new MongoClient(Environment.GetEnvironmentVariable("MONGODB_URI"));\nvar coll = client.GetDatabase(${dq(q.db)}).GetCollection<BsonDocument>(${dq(q.coll)});\n\n`
      const c = colDoc && csCollation(colDoc)
      const cDecl = c ? `var collation = ${c};\n` : ''
      if (q.kind === 'aggregate') return `${head}var pipeline = new[]\n${b.pipeline!.replace(/^new BsonArray/, '').trim()};\n${cDecl}\nvar docs = coll.Aggregate<BsonDocument>(pipeline${c ? ', new AggregateOptions { Collation = collation }' : ''}).ToList();`
      return `${head}var filter = ${b.filter};\n${b.projection ? `var projection = ${b.projection};\n` : ''}${b.sort ? `var sort = ${b.sort};\n` : ''}${cDecl}\nvar docs = coll.Find(filter${c ? ', new FindOptions { Collation = collation }' : ''})${b.projection ? '\n    .Project(projection)' : ''}${b.sort ? '\n    .Sort(sort)' : ''}${skip ? `\n    .Skip(${skip})` : ''}${limit ? `\n    .Limit(${limit})` : ''}\n    .ToList();`
    }
    case 'go': {
      const b = body(q, goLang)
      const helpers = `func mustObjectID(s string) bson.ObjectID {\n  id, err := bson.ObjectIDFromHex(s)\n  if err != nil {\n    panic(err)\n  }\n  return id\n}\n\nfunc mustDecimal(s string) bson.Decimal128 {\n  d, err := bson.ParseDecimal128(s)\n  if err != nil {\n    panic(err)\n  }\n  return d\n}\n\n`
      const head = `import (\n  "context"\n  "os"\n\n  "go.mongodb.org/mongo-driver/v2/bson"\n  "go.mongodb.org/mongo-driver/v2/mongo"\n  "go.mongodb.org/mongo-driver/v2/mongo/options"\n)\n\n${helpers}ctx := context.Background()\nclient, _ := mongo.Connect(options.Client().ApplyURI(os.Getenv("MONGODB_URI")))\ncoll := client.Database(${dq(q.db)}).Collection(${dq(q.coll)})\n\n`
      const c = colDoc && goCollation(colDoc)
      if (q.kind === 'aggregate') return `${head}pipeline := mongo.Pipeline${b.pipeline!.replace(/^bson\.A/, '')}\n\ncursor, err := coll.Aggregate(ctx, pipeline${c ? `, options.Aggregate().SetCollation(${c})` : ''})\nvar docs []bson.M\nerr = cursor.All(ctx, &docs)`
      const opts = [b.projection && `SetProjection(${b.projection})`, b.sort && `SetSort(${b.sort})`, skip && `SetSkip(${skip})`, limit && `SetLimit(${limit})`, c && `SetCollation(${c})`].filter(Boolean)
      return `${head}filter := ${b.filter}\nopts := options.Find()${opts.map((o) => `.\n  ${o}`).join('')}\n\ncursor, err := coll.Find(ctx, filter, opts)\nvar docs []bson.M\nerr = cursor.All(ctx, &docs)`
    }
    case 'php': {
      const b = body(q, phpLang)
      const head = `<?php\nrequire 'vendor/autoload.php';\n\n$client = new MongoDB\\Client(getenv('MONGODB_URI'));\n$coll = $client->selectCollection(${sqRaw(q.db)}, ${sqRaw(q.coll)});\n\n`
      const c = colDoc && render(colDoc, phpLang)
      if (q.kind === 'aggregate') return `${head}$pipeline = ${b.pipeline};\n\n$docs = $coll->aggregate($pipeline${c ? `, ['collation' => ${c}]` : ''})->toArray();`
      const opts = [b.projection && `'projection' => ${b.projection}`, b.sort && `'sort' => ${b.sort}`, skip && `'skip' => ${skip}`, limit && `'limit' => ${limit}`, c && `'collation' => ${c}`].filter(Boolean)
      return `${head}$filter = ${b.filter};\n${opts.length ? `$options = [${opts.join(', ')}];\n\n$docs = $coll->find($filter, $options)->toArray();` : `\n$docs = $coll->find($filter)->toArray();`}`
    }
    case 'ruby': {
      const b = body(q, rubyLang)
      const head = `require 'mongo'\nrequire 'time'\n\nclient = Mongo::Client.new(ENV['MONGODB_URI'], database: ${sqRaw(q.db)})\ncoll = client[${sqRaw(q.coll)}]\n\n`
      const c = colDoc && rubyCollation(colDoc)
      if (q.kind === 'aggregate') return `${head}pipeline = ${b.pipeline}\n\ndocs = coll.aggregate(pipeline${c ? `, collation: ${c}` : ''}).to_a`
      return `${head}filter = ${b.filter}\n\ndocs = coll.find(filter${c ? `, collation: ${c}` : ''})${b.projection ? `\n  .projection(${b.projection})` : ''}${b.sort ? `\n  .sort(${b.sort})` : ''}${skip ? `\n  .skip(${skip})` : ''}${limit ? `\n  .limit(${limit})` : ''}\n  .to_a`
    }
  }
}
