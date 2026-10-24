import { Binary, Long } from 'bson'
import { isPlainDoc, shellText } from '@shared/bsonValue'
import type { PlaygroundResult } from '@shared/api'
import { printValue } from '@shared/shellOptions'
import type { ShellPrintOptions } from '@shared/shellOptions'
import { REPR } from './shell'

const MAX_DEPTH = 40
const MAX_NODES = 500_000

const tagOf = (v: object): string => Object.prototype.toString.call(v)

function isMongooseDoc(v: object): v is { toObject(o: object): unknown } {
  return '$__' in v && typeof (v as { toObject?: unknown }).toObject === 'function'
}

/** Plain-object check that works across realms (the sandbox has its own Object). */
function isPlainObject(v: object): boolean {
  if (tagOf(v) !== '[object Object]') return false
  const proto = Object.getPrototypeOf(v)
  return proto === null || Object.getPrototypeOf(proto) === null
}

function className(v: object): string {
  const c = (v as { constructor?: { name?: string } }).constructor
  return typeof c?.name === 'string' && c.name ? c.name : 'Object'
}

/**
 * Deep copy of a sandbox value into this realm, in shapes EJSON understands: mongoose documents → plain objects,
 * Dates/RegExps re-created, typed arrays → Binary, bigint → Long, Map → object, Set → array, cycles cut.
 */
export function toPlain(value: unknown): unknown {
  let nodes = 0
  const seen = new Set<object>()
  const conv = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v
    if (typeof v === 'bigint') return Long.fromBigInt(v)
    if (typeof v === 'symbol') return v.toString()
    if (typeof v === 'function') {
      const f = v as { modelName?: string; name?: string }
      return f.modelName ? `[Model ${f.modelName}]` : `[Function${f.name ? ` ${f.name}` : ''}]`
    }
    const o = v as object
    if (++nodes > MAX_NODES) return '[Truncated]'
    if ('_bsontype' in o) return o
    const tag = tagOf(o)
    if (tag === '[object Date]') return new Date((o as Date).getTime())
    if (tag === '[object RegExp]') return new RegExp((o as RegExp).source, (o as RegExp).flags)
    if (ArrayBuffer.isView(o)) return new Binary(new Uint8Array(o.buffer, o.byteOffset, o.byteLength))
    if (tag === '[object Promise]') return '[Promise]'
    if (REPR in o) return (o as { [REPR]: string })[REPR]
    if (seen.has(o)) return '[Circular]'
    if (depth > MAX_DEPTH) return `[${className(o)}]`
    seen.add(o)
    try {
      if (isMongooseDoc(o)) return conv(o.toObject({ flattenMaps: true, depopulate: true, virtuals: false }), depth)
      if (Array.isArray(o)) return o.map((x) => conv(x, depth + 1))
      if (tag === '[object Map]') return conv(Object.fromEntries(o as Map<unknown, unknown>), depth)
      if (tag === '[object Set]') return conv([...(o as Set<unknown>)], depth)
      if (o instanceof Error || tag === '[object Error]') {
        const e = o as Error & Record<string, unknown>
        return conv({ name: e.name, message: e.message, ...Object.fromEntries(Object.entries(e)) }, depth)
      }
      const name = className(o)
      if (!isPlainObject(o) && /^(MongoClient|Db|Collection|Topology|Connection|NativeConnection|Mongoose)$/.test(name)) return `[${name}]`
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(o)) {
        if (x === undefined) continue
        out[k] = conv(x, depth + 1)
      }
      return out
    } finally {
      seen.delete(o)
    }
  }
  return conv(value, 0)
}

export interface Shaped {
  value: unknown
  valueKind: PlaygroundResult['valueKind']
  /** Original length when an array was cut. */
  truncatedFrom?: number
}

export function shape(value: unknown, limit: number): Shaped {
  if (value === undefined) return { value: undefined, valueKind: 'undefined' }
  if (Array.isArray(value)) {
    const cut = value.length > limit ? value.slice(0, limit) : value
    const docs = cut.every((d) => isPlainDoc(d))
    return { value: cut, valueKind: docs ? 'documents' : 'value', truncatedFrom: value.length > limit ? value.length : undefined }
  }
  if (isPlainDoc(value)) return { value, valueKind: 'document' }
  return { value, valueKind: 'value' }
}

/** Text of one console.log argument (shell sessions pass their print options). */
export function formatArg(v: unknown, print?: ShellPrintOptions): string {
  if (typeof v === 'string') return v
  if (v === undefined) return 'undefined'
  if (typeof v === 'function') return toPlain(v) as string
  if (v && typeof v === 'object') {
    if (REPR in v) return (v as { [REPR]: string })[REPR]
    if (v instanceof Error || tagOf(v) === '[object Error]') return (v as Error).stack ?? String(v)
  }
  try {
    return print ? printValue(toPlain(v), print) : shellText(toPlain(v), 2)
  } catch {
    return String(v)
  }
}

export const formatArgs = (args: unknown[], print?: ShellPrintOptions): string => args.map((a) => formatArg(a, print)).join(' ')
