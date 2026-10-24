import type { PlaygroundResult } from './api'
import type { ShellStartupReport } from './shellOptions'

/** What `shellEval` returns: a playground result plus shell session state. */
export type ShellResult = PlaygroundResult & {
  /** Current database after the command (changes with `use`). */
  db?: string
  /** The last cursor has more documents: type `it`. */
  more?: boolean
  /** The session was restarted (interrupt, timeout, crash): variables are gone. */
  reset?: boolean
  /** The session could not reach the server: offer to reconnect. */
  lost?: boolean
  /** The session was (re)started for this command and ran its startup scripts. */
  startup?: ShellStartupReport[]
}

/** Default documents per batch of a cursor (`it` shows the next one), like mongosh; Settings → Shell & Playground changes it. */
export const SHELL_BATCH = 20

export type ShellCommand =
  | { kind: 'use'; db: string }
  | { kind: 'show'; what: string; arg?: string }
  | { kind: 'it' }
  | { kind: 'help' }
  | { kind: 'cls' }
  | { kind: 'exit' }

const DB_NAME = /^[^\s/\\."$*<>:|?;,()=+'`{}[\]!&]+$/

/** mongosh statement-style commands (`use x`, `show dbs`, `it`…); null for JavaScript. */
export function parseCommand(input: string): ShellCommand | null {
  const s = input.trim().replace(/;+$/, '').trim()
  if (s === 'it') return { kind: 'it' }
  if (s === 'help' || s === 'help()') return { kind: 'help' }
  if (s === 'cls' || s === 'clear') return { kind: 'cls' }
  if (s === 'exit' || s === 'quit' || s === 'exit()' || s === 'quit()') return { kind: 'exit' }
  let m = /^use\s+(\S+)$/.exec(s)
  if (m && DB_NAME.test(m[1])) return { kind: 'use', db: m[1] }
  m = /^show\s+([A-Za-z]+)(?:\s+(\S+))?$/.exec(s)
  if (m) return { kind: 'show', what: m[1].toLowerCase(), arg: m[2] }
  return null
}

/**
 * True while the input cannot be complete: unclosed brackets, strings, template literals or block comments.
 * Enter then inserts a newline instead of running.
 */
export function isIncomplete(code: string): boolean {
  const stack: string[] = []
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      if (end < 0) return true
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      i++
      while (i < n && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1
      if (i >= n) return false
      i++
      continue
    }
    if (c === '`') {
      i++
      while (i < n && code[i] !== '`') i += code[i] === '\\' ? 2 : 1
      if (i >= n) return true
      i++
      continue
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c)
    else if (c in pairs) {
      if (stack[stack.length - 1] !== pairs[c]) return false
      stack.pop()
    }
    i++
  }
  return stack.length > 0
}

export const SHELL_HELP = `Shell commands
  use <db>                 switch the current database
  show dbs                 list databases with their size
  show collections         list collections of the current database
  show users / show roles  users and roles of the current database
  show profile             last 5 operations recorded by the profiler
  it                       next batch of documents of the last cursor
  cls / clear              clear the screen (Ctrl+L)
  exit                     close this shell tab
  help                     this help

JavaScript
  db.<collection>.find(filter, projection)   …and every mongosh-style collection method
  db.getSiblingDB('other'), db.runCommand({ … }), db.adminCommand({ … })
  ObjectId(), ISODate(), NumberLong(), NumberDecimal(), UUID(), EJSON
  mongoose, model('Name'), Customer.find()   Mongoose bound to this connection
  print(), printjson(), console.log()        output appears above the result
  Variables, functions and classes persist between commands; top-level await works.

Keys
  Enter run · Shift+Enter new line · ↑/↓ history · Ctrl+C interrupt · Ctrl+L clear`
