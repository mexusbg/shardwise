import { EJSON } from 'bson'

/**
 * IPC wire format. Canonical EJSON keeps BSON wrappers (Int32, Double, Long, …) intact, but it also turns plain
 * JS numbers into Int32/Double on the other side. Documents are read with promoteValues:false, so a plain
 * number is always an API-level number (count, port, page size…). Tag those so they come back as numbers.
 */
const NUM = '$mgNum'
/**
 * Plain objects with `$` keys (query operators) are sent as entry lists: EJSON.parse would otherwise read
 * `{ $regex, $options, $ne }` as a legacy regex and silently drop `$ne`, widening filters.
 */
const OBJ = '$mgObj'

function isBsonLike(v: object): boolean {
  return '_bsontype' in v || v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v)
}

function tag(v: unknown): unknown {
  if (typeof v === 'number') return { [NUM]: String(v) }
  if (v === null || typeof v !== 'object' || isBsonLike(v)) return v
  if (Array.isArray(v)) return v.map(tag)
  // EJSON would turn undefined properties into null; omit them like JSON does.
  const entries = Object.entries(v).filter(([, x]) => x !== undefined)
  if (entries.some(([k]) => k.startsWith('$'))) return { [OBJ]: entries.map(([k, x]) => [k, tag(x)]) }
  // fromEntries defines own properties: a `__proto__` field stays a field instead of setting the prototype.
  return Object.fromEntries(entries.map(([k, x]) => [k, tag(x)]))
}

function untag(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || isBsonLike(v)) return v
  if (Array.isArray(v)) return v.map(untag)
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1 && keys[0] === NUM && typeof o[NUM] === 'string') return Number(o[NUM])
  if (keys.length === 1 && keys[0] === OBJ && Array.isArray(o[OBJ])) return Object.fromEntries((o[OBJ] as [string, unknown][]).map(([k, x]) => [k, untag(x)]))
  for (const k of keys) o[k] = untag(o[k])
  return o
}

export const encodeIpc = (v: unknown): string => EJSON.stringify(tag(v ?? null), { relaxed: false })

export const decodeIpc = (s: string): unknown => untag(EJSON.parse(s, { relaxed: false }))
