/**
 * The shell parser (mongodb-query-parser → @mongodb-js/shell-bson-parser) builds UUID(), BinData() and the legacy
 * UUID helpers with Node's global `Buffer.from(text, 'hex' | 'base64')`. The app window has no Buffer, so parsing
 * a document or filter holding one failed with "Buffer is not defined".
 *
 * `withNodeBuffer` lends a minimal Buffer (just `from` for hex and base64, giving a Uint8Array that bson's Binary
 * takes) for the length of a synchronous parse. It is not left installed: bson and other libraries look for a
 * global Buffer when they load and would treat a partial one as Node's.
 */

const HEX = /^[0-9a-f]{2}$/i

/** Hex to bytes, stopping at the first pair that is not hex (as Node does). */
function hexBytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i + 1 < s.length; i += 2) {
    const pair = s.slice(i, i + 2)
    if (!HEX.test(pair)) break
    out.push(parseInt(pair, 16))
  }
  return Uint8Array.from(out)
}

/** Base64 (or base64url) to bytes; padding is optional and other characters are skipped (as Node does). */
function base64Bytes(s: string): Uint8Array {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const shim = {
  from(value: unknown, encoding?: string): Uint8Array {
    if (typeof value !== 'string') return Uint8Array.from(value as ArrayLike<number>)
    const enc = (encoding ?? 'utf8').toLowerCase()
    if (enc === 'hex') return hexBytes(value)
    if (enc === 'base64' || enc === 'base64url') return base64Bytes(value)
    return new TextEncoder().encode(value)
  }
}

/** Runs a synchronous parse with a Buffer available (Node's own where there is one). */
export function withNodeBuffer<T>(fn: () => T): T {
  const g = globalThis as { Buffer?: unknown }
  if (g.Buffer !== undefined) return fn()
  g.Buffer = shim
  try {
    return fn()
  } finally {
    delete g.Buffer
  }
}
