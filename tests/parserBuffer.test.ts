import { describe, expect, it } from 'vitest'
import { withNodeBuffer } from '@shared/parserBuffer'

// The parse itself is checked in the app window by the e2e run (bson there loads without Buffer and takes the
// browser path); here the loaned Buffer is compared with Node's.

const NodeBuffer = globalThis.Buffer

/** Runs `fn` without Node's Buffer, as in the app window. */
function withoutBuffer<T>(fn: () => T): T {
  const g = globalThis as { Buffer?: unknown }
  delete g.Buffer
  try {
    return fn()
  } finally {
    g.Buffer = NodeBuffer
  }
}

type From = { from: (v: string, enc: string) => Uint8Array }
const loaned = (v: string, enc: string): number[] => withoutBuffer(() => withNodeBuffer(() => [...(globalThis as unknown as { Buffer: From }).Buffer.from(v, enc)]))
const node = (v: string, enc: BufferEncoding): number[] => [...NodeBuffer.from(v, enc)]

describe('Buffer loaned to the shell parser', () => {
  it('decodes hex and base64 as Node does', () => {
    for (const hex of ['0e0c6a4e5b8f4c1a9a3e2f6d7b8c9d01', 'ABCDEF', 'abc', '12zz34', '']) expect(loaned(hex, 'hex'), hex).toEqual(node(hex, 'hex'))
    for (const b64 of ['SGVsbG8=', 'SGVsbG8', 'SGVs bG8=', 'a-_b', '']) expect(loaned(b64, 'base64'), b64).toEqual(node(b64, 'base64'))
    expect(loaned('héllo', 'utf8')).toEqual(node('héllo', 'utf8'))
  })

  it('is there only during the parse, and Node’s own is used where it exists', () => {
    withoutBuffer(() => {
      expect(() =>
        withNodeBuffer(() => {
          expect((globalThis as { Buffer?: unknown }).Buffer).toBeDefined()
          throw new Error('parse failed')
        })
      ).toThrow('parse failed')
      expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined()
    })
    expect(withNodeBuffer(() => globalThis.Buffer)).toBe(NodeBuffer)
  })
})
