import { parse } from 'acorn'
import type { PlaygroundLanguage } from '@shared/api'

/** Name of the sandbox function the last expression is passed to. */
export const RESULT_FN = '__mgResult'

export interface Prepared {
  /** Plain JavaScript; line numbers match the user's code. */
  js: string
  /** Identifiers read somewhere in the code. */
  references: Set<string>
  /** Identifiers declared somewhere in the code (variables, functions, classes, parameters). */
  bindings: Set<string>
  /** Database names passed as string literals to use() / getSiblingDB(). */
  dbNames: string[]
  /** Where the last-expression rewrite inserted text (1-based line, 0-based column). */
  rewrite?: { line: number; column: number; length: number }
}

export class PlaygroundSyntaxError extends Error {
  constructor(
    message: string,
    public line?: number,
    public column?: number,
    public frame?: string
  ) {
    super(message)
    this.name = 'SyntaxError'
  }
}

interface AstNode {
  type: string
  start: number
  end: number
  [k: string]: unknown
}

const isNode = (v: unknown): v is AstNode => !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string'

function walk(node: AstNode, parent: AstNode | null, key: string, visit: (n: AstNode, parent: AstNode | null, key: string) => void): void {
  visit(node, parent, key)
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) walk(c, node, k, visit)
    } else if (isNode(v)) {
      walk(v, node, k, visit)
    }
  }
}

function patternNames(p: unknown, out: Set<string>): void {
  if (!isNode(p)) return
  switch (p.type) {
    case 'Identifier':
      out.add(p.name as string)
      break
    case 'ObjectPattern':
      for (const prop of p.properties as AstNode[]) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out)
      break
    case 'ArrayPattern':
      for (const e of p.elements as AstNode[]) patternNames(e, out)
      break
    case 'AssignmentPattern':
      patternNames(p.left, out)
      break
    case 'RestElement':
      patternNames(p.argument, out)
      break
  }
}

/** Position of a 0-based offset as 1-based line / 0-based column. */
function position(src: string, offset: number): { line: number; column: number } {
  const before = src.slice(0, offset).split('\n')
  return { line: before.length, column: before[before.length - 1].length }
}

export function codeFrame(code: string, line: number, column?: number): string {
  const lines = code.split('\n')
  const out: string[] = []
  const width = String(Math.min(lines.length, line + 1)).length
  for (let i = Math.max(1, line - 2); i <= Math.min(lines.length, line + 1); i++) {
    out.push(`${i === line ? '>' : ' '} ${String(i).padStart(width)} | ${lines[i - 1].replace(/\t/g, '  ')}`)
    if (i === line && column !== undefined) out.push(`  ${' '.repeat(width)} | ${' '.repeat(column)}^`)
  }
  return out.join('\n')
}

function syntaxError(code: string, message: string, line?: number, column?: number, exactColumn = true): PlaygroundSyntaxError {
  const clean = message.replace(/\s*\(\d+:\d+\)\s*$/, '')
  const where = line ? ` (line ${line}${column !== undefined ? `:${column + 1}` : ''})` : ''
  return new PlaygroundSyntaxError(`${clean}${where}`, line, column, line ? codeFrame(code, line, exactColumn ? column : undefined) : undefined)
}

async function stripTypes(code: string): Promise<string> {
  const { transform } = await import('sucrase')
  try {
    return transform(code, { transforms: ['typescript'], disableESTransforms: true }).code
  } catch (e) {
    const m = /\((\d+):(\d+)\)/.exec((e as Error).message)
    throw syntaxError(code, (e as Error).message, m ? Number(m[1]) : undefined, m ? Number(m[2]) : undefined)
  }
}

/**
 * Turns playground code into a function body: strips TypeScript, rejects imports, and rewrites the last
 * top-level expression statement into `return __mgResult(<expr>)` (mongosh-like completion value).
 */
export interface PrepareOptions {
  /**
   * REPL mode: top-level declarations become globals of the context so they survive into the next evaluation
   * (`const a = 1` → `a = 1`, `function f() {}` → also `globalThis.f = f`).
   */
  hoist?: boolean
}

/** Keeps line breaks (and so line numbers) of replaced source text. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ')

function hoistEdits(st: AstNode, src: string): { start: number; end: number; text: string }[] {
  if (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') {
    const name = isNode(st.id) ? (st.id.name as string) : undefined
    return name ? [{ start: st.end, end: st.end, text: `;globalThis.${name} = ${name};` }] : []
  }
  if (st.type !== 'VariableDeclaration') return []
  const decls = st.declarations as AstNode[]
  const kind = st.kind as string
  const undef = (d: AstNode): string => {
    const n = (d.id as AstNode).name as string
    return kind === 'var' ? ` = typeof ${n} === 'undefined' ? undefined : ${n}` : ' = undefined'
  }
  const head = src.slice(st.start, decls[0].start)
  const edits = [{ start: st.start, end: decls[0].start, text: `;(${blank(head.slice(2))}` }]
  decls.forEach((d, i) => {
    const last = i === decls.length - 1
    const missing = !d.init && (d.id as AstNode).type === 'Identifier'
    if (last) edits.push({ start: d.end, end: d.end, text: `${missing ? undef(d) : ''})` })
    else if (missing) edits.push({ start: d.end, end: d.end, text: undef(d) })
  })
  return edits
}

export async function prepare(code: string, language: PlaygroundLanguage, opts: PrepareOptions = {}): Promise<Prepared> {
  const src = language === 'typescript' ? await stripTypes(code) : code
  let ast: AstNode
  try {
    ast = parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true
    }) as unknown as AstNode
  } catch (e) {
    const pos = (e as { pos?: number }).pos
    const p = pos !== undefined ? position(src, pos) : undefined
    throw syntaxError(code, (e as Error).message, p?.line, p?.column, language === 'javascript')
  }

  const edits: { start: number; end: number; text: string }[] = []
  const body = ast.body as AstNode[]
  let last: AstNode | undefined
  let rewrite: Prepared['rewrite']
  for (const st of body) {
    switch (st.type) {
      case 'ImportDeclaration': {
        const p = position(src, st.start)
        throw syntaxError(code, 'import statements are not supported; use the provided globals (db, client, mongoose, ObjectId, …)', p.line, p.column, language === 'javascript')
      }
      case 'ExportNamedDeclaration':
        if (isNode(st.declaration)) {
          edits.push({ start: st.start, end: st.declaration.start, text: '' })
          last = st.declaration
        } else {
          edits.push({ start: st.start, end: st.end, text: '' })
        }
        continue
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration': {
        const p = position(src, st.start)
        throw syntaxError(code, 'export statements are not supported', p.line, p.column, language === 'javascript')
      }
    }
    last = st
    if (opts.hoist) edits.push(...hoistEdits(st, src))
  }
  // Like mongosh, each top-level expression statement is awaited: `db.coll.insertOne(…)` on its own line finishes
  // before the next line runs (and before the run closes its client, which otherwise fails the pending call).
  for (const st of body) {
    if (st === last || st.type !== 'ExpressionStatement' || st.directive || (st.expression as AstNode).type === 'AwaitExpression') continue
    const semi = src[st.end - 1] === ';'
    const end = semi ? st.end - 1 : st.end
    edits.push({ start: st.start, end: st.start, text: 'await (' }, { start: end, end, text: semi ? ')' : ');' })
  }
  if (last?.type === 'ExpressionStatement' && !last.directive) {
    const end = src[last.end - 1] === ';' ? last.end - 1 : last.end
    rewrite = { ...position(src, last.start), length: RESULT_FN.length + 8 }
    edits.push({ start: last.start, end: last.start, text: `return ${RESULT_FN}(` }, { start: end, end, text: ')' })
  }

  const references = new Set<string>()
  const bindings = new Set<string>()
  const dbNames: string[] = []
  walk(ast, null, '', (n, parent, key) => {
    switch (n.type) {
      case 'Identifier': {
        if (!parent) break
        const pt = parent.type
        if (pt === 'MemberExpression' && key === 'property' && !parent.computed) break
        if ((pt === 'Property' || pt === 'MethodDefinition' || pt === 'PropertyDefinition') && key === 'key' && !parent.computed && !parent.shorthand) break
        if ((pt === 'LabeledStatement' || pt === 'BreakStatement' || pt === 'ContinueStatement') && key === 'label') break
        if (pt === 'MetaProperty') break
        references.add(n.name as string)
        break
      }
      case 'VariableDeclarator':
        patternNames(n.id, bindings)
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        patternNames(n.id, bindings)
        for (const p of n.params as AstNode[]) patternNames(p, bindings)
        break
      case 'ClassDeclaration':
      case 'ClassExpression':
        patternNames(n.id, bindings)
        break
      case 'CatchClause':
        patternNames(n.param, bindings)
        break
      case 'CallExpression': {
        const callee = n.callee as AstNode
        const arg = (n.arguments as AstNode[])[0]
        const isUse = (callee.type === 'Identifier' && callee.name === 'use') || (callee.type === 'MemberExpression' && (callee.property as AstNode).name === 'getSiblingDB')
        if (isUse && arg?.type === 'Literal' && typeof arg.value === 'string') dbNames.push(arg.value)
        break
      }
    }
  })

  let js = src
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) js = js.slice(0, e.start) + e.text + js.slice(e.end)
  return { js, references, bindings, dbNames, rewrite }
}
