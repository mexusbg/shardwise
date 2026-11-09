import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { foldable } from '@codemirror/language'
import { bracketFoldAt, bracketFolding } from '@shared/bracketFold'

const at = (doc: string, lineNo: number): { from: number; to: number } | null => {
  const s = EditorState.create({ doc })
  const l = s.doc.line(lineNo)
  return bracketFoldAt(s, l.from, l.to)
}
const inner = (doc: string, r: { from: number; to: number } | null): string | null => (r ? doc.slice(r.from, r.to) : null)

describe('bracket folding', () => {
  it('folds an array or object from the end of its line to its closing bracket', () => {
    const doc = "{\n  data: [\n    { a: 1 },\n    { b: [2] }\n  ],\n  x: 1\n}"
    expect(inner(doc, at(doc, 2))).toBe('\n    { a: 1 },\n    { b: [2] }\n  ')
    expect(inner(doc, at(doc, 1))).toBe(doc.slice(1, -1))
    expect(at(doc, 3)).toBeNull() // closes on the same line
    expect(at(doc, 6)).toBeNull()
  })

  it('skips brackets inside strings, comments and regular expressions', () => {
    const doc = "{\n  s: 'a } [ \\' ]',\n  d: \"]\",\n  t: `}`,\n  // ]\n  /* } */\n  r: /[\\]}]+\\//i,\n  q: 4 / 2\n}"
    expect(inner(doc, at(doc, 1))).toBe(doc.slice(1, -1))
  })

  it('gives no fold when the brackets do not pair', () => {
    expect(at('{\n  a: [1, 2}\n}', 1)).toBeNull()
    expect(at('[\n  1,\n', 1)).toBeNull()
  })

  it('folds a large array the parser has not finished', () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `    {\n      _id: ObjectId('${i.toString(16).padStart(24, '0')}'),\n      activeR: ${i}.5\n    }`)
    const doc = `{\n  createdAt: ISODate('2026-10-09T22:51:12.441Z'),\n  data: [\n${rows.join(',\n')}\n  ]\n}`
    const line = EditorState.create({ doc }).doc.line(3)
    const plain = EditorState.create({ doc, extensions: [javascript()] })
    expect(foldable(plain, line.from, line.to)).toBeNull() // the parse stops well before the closing "]"
    const withFallback = EditorState.create({ doc, extensions: [javascript(), bracketFolding()] })
    const r = foldable(withFallback, line.from, line.to)
    expect(r?.from).toBe(line.to)
    expect(doc.slice(r!.to)).toBe(']\n}')
  })
})
