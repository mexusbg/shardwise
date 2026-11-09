import type { EditorState, Extension, Text } from '@codemirror/state'
import { foldService, syntaxTreeAvailable } from '@codemirror/language'

/**
 * Folding by matching brackets, for lines that end with "{" or "[".
 *
 * CodeMirror folds from the syntax tree, but it parses a large document only up to a distance past what is on
 * screen: an object or array that closes beyond that point counts as unfinished and gets no fold marker (the
 * "data: [" of a document with thousands of entries). Until the whole document is parsed, this finds the closing
 * bracket in the text instead, skipping strings, comments and regular expression literals.
 */
export function bracketFolding(): Extension {
  return foldService.of((state, lineStart, lineEnd) => {
    if (syntaxTreeAvailable(state, state.doc.length)) return null
    return bracketFoldAt(state, lineStart, lineEnd)
  })
}

const cache = new WeakMap<Text, Map<number, { from: number; to: number } | null>>()

/** The range inside the bracket that ends the line, up to its closing bracket; null when the line does not end with one. */
export function bracketFoldAt(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const text = state.doc.sliceString(lineStart, lineEnd).trimEnd()
  const last = text[text.length - 1]
  if (last !== '{' && last !== '[') return null
  const open = lineStart + text.length - 1
  let known = cache.get(state.doc)
  if (!known) cache.set(state.doc, (known = new Map()))
  if (known.has(open)) return known.get(open)!
  const close = matchingClose(state.doc, open)
  const range = close !== null && close > lineEnd ? { from: open + 1, to: close } : null
  known.set(open, range)
  return range
}

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

/** Position of the bracket that closes the one at `open`, or null when there is none or the brackets do not pair. */
function matchingClose(doc: Text, open: number): number | null {
  const stack: string[] = [PAIRS[doc.sliceString(open, open + 1)]]
  // Modes: code, a quoted string (its quote), a comment, a regular expression (and a class inside one).
  let mode: 'code' | "'" | '"' | '`' | 'line' | 'block' | 'regex' | 'class' = 'code'
  let escaped = false
  let prev = '' // previous character, for "//", "/*" and "*/"
  let sig = '[' // last character of code that is not a space: tells a regular expression from a division
  let pos = open + 1
  for (const iter = doc.iterRange(pos); !iter.next().done; ) {
    if (iter.lineBreak) {
      if (mode === 'line') mode = 'code'
      prev = '\n'
      pos += 1
      continue
    }
    const chunk = iter.value
    for (let i = 0; i < chunk.length; i++, pos++) {
      const ch = chunk[i]
      switch (mode) {
        case 'code':
          if (ch === '/' && prev === '/') {
            mode = 'line'
          } else if (ch === '*' && prev === '/') {
            mode = 'block'
            prev = ''
            continue
          } else if (ch === "'" || ch === '"' || ch === '`') {
            mode = ch
          } else if (ch === '/') {
            // Decided by the next character: "//" and "/*" are comments; otherwise a regular expression when it
            // follows an operator or an opening bracket.
            const next = chunk[i + 1] ?? ''
            if (next !== '/' && next !== '*' && /[([{,:;=!&|?+\-*%<>~^]/.test(sig)) mode = 'regex'
          } else if (ch === '{' || ch === '[' || ch === '(') {
            stack.push(PAIRS[ch])
          } else if (ch === '}' || ch === ']' || ch === ')') {
            if (stack.pop() !== ch) return null
            if (!stack.length) return pos
          }
          if (mode === 'code' && ch !== ' ' && ch !== '\t' && ch !== '\r') sig = ch
          break
        case "'":
        case '"':
        case '`':
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === mode) {
            mode = 'code'
            sig = ch
          }
          break
        case 'block':
          if (ch === '/' && prev === '*') {
            mode = 'code'
            prev = ''
            continue
          }
          break
        case 'regex':
        case 'class':
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (mode === 'regex' && ch === '[') mode = 'class'
          else if (mode === 'class' && ch === ']') mode = 'regex'
          else if (mode === 'regex' && ch === '/') {
            mode = 'code'
            sig = ch
          }
          break
        case 'line':
          break
      }
      prev = ch
    }
  }
  return null
}
