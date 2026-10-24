import { bsonTypeOf, convertValue, editText, isEditableType, parseTyped } from '../bsonValue'
import type { EditableType } from '../bsonValue'
import { getPath, hasPath } from '../docPaths'
import { OPERATOR_BY_ID } from './operators'
import { newRule, nid } from './types'
import type { Group, GroupOp, Node, Rule } from './types'

export function findNode(root: Group, id: string): Node | null {
  if (root.id === id) return root
  for (const c of root.children) {
    if (c.id === id) return c
    if (c.kind === 'group') {
      const f = findNode(c, id)
      if (f) return f
    }
  }
  return null
}

export function parentOf(root: Group, id: string): Group | null {
  for (const c of root.children) {
    if (c.id === id) return root
    if (c.kind === 'group') {
      const p = parentOf(c, id)
      if (p) return p
    }
  }
  return null
}

/** True when `id` is `n` itself or one of its descendants. */
export function containsNode(n: Node, id: string): boolean {
  return n.id === id || (n.kind === 'group' && n.children.some((c) => containsNode(c, id)))
}

/** Immutably replace the node with the given id. Unchanged subtrees keep their identity. */
export function updateNode(root: Group, id: string, fn: (n: Node) => Node): Group {
  if (root.id === id) return fn(root) as Group
  let changed = false
  const children = root.children.map((c) => {
    if (c.id === id) {
      changed = true
      return fn(c)
    }
    if (c.kind !== 'group') return c
    const u = updateNode(c, id, fn)
    if (u !== c) changed = true
    return u
  })
  return changed ? { ...root, children } : root
}

const editChildren = (root: Group, groupId: string, fn: (children: Node[]) => Node[]): Group =>
  updateNode(root, groupId, (g) => (g.kind === 'group' ? { ...g, children: fn(g.children) } : g))

export function removeNode(root: Group, id: string): Group {
  const p = parentOf(root, id)
  return p ? editChildren(root, p.id, (cs) => cs.filter((c) => c.id !== id)) : root
}

/** Deep copy with fresh ids. */
export function cloneNode<T extends Node>(n: T): T {
  return n.kind === 'group' ? { ...n, id: nid(), children: n.children.map(cloneNode) } : { ...n, id: nid() }
}

/** Insert a copy of the node right after it. */
export function duplicateNode(root: Group, id: string): Group {
  const p = parentOf(root, id)
  if (!p) return root
  return editChildren(root, p.id, (cs) => {
    const i = cs.findIndex((c) => c.id === id)
    return [...cs.slice(0, i + 1), cloneNode(cs[i]), ...cs.slice(i + 1)]
  })
}

/** Insert a node into a group at `index` (default: at the end). */
export function insertNode(root: Group, groupId: string, node: Node, index = Infinity): Group {
  return editChildren(root, groupId, (cs) => {
    const out = [...cs]
    out.splice(Math.min(index, out.length), 0, node)
    return out
  })
}

export const addRule = (root: Group, groupId: string, rule: Rule = newRule()): Group => insertNode(root, groupId, rule)

export function addGroup(root: Group, groupId: string, op?: GroupOp): Group {
  const parent = findNode(root, groupId)
  const g: Group = { kind: 'group', id: nid(), enabled: true, op: op ?? (parent?.kind === 'group' && parent.op === 'and' ? 'or' : 'and'), children: [] }
  return insertNode(root, groupId, g)
}

/** Whether node `id` may be moved into group `groupId` (not into itself or its own subtree). */
export function canMoveInto(root: Group, id: string, groupId: string): boolean {
  const n = findNode(root, id)
  return !!n && n !== root && !containsNode(n, groupId)
}

/** Move a node into a group, before the child currently at `index` (indexes refer to the tree before the move). */
export function moveNode(root: Group, id: string, groupId: string, index = Infinity): Group {
  const p = parentOf(root, id)
  const target = findNode(root, groupId)
  if (!p || target?.kind !== 'group' || !canMoveInto(root, id, groupId)) return root
  const from = p.children.findIndex((c) => c.id === id)
  const node = p.children[from]
  let at = Math.min(index, target.children.length)
  if (p.id === groupId) {
    if (at === from || at === from + 1) return root
    if (from < at) at--
  }
  return insertNode(removeNode(root, id), groupId, node, at)
}

/** Move a list item so it lands before the item currently at `index` (end when index >= length). */
export function moveItem<T extends { id: string }>(list: T[], id: string, index: number): T[] {
  const from = list.findIndex((x) => x.id === id)
  if (from < 0) return list
  let at = Math.min(index, list.length)
  if (at === from || at === from + 1) return list
  if (from < at) at--
  const out = list.filter((x) => x.id !== id)
  out.splice(at, 0, list[from])
  return out
}

export function insertItem<T>(list: T[], item: T, index = Infinity): T[] {
  const out = [...list]
  out.splice(Math.min(index, out.length), 0, item)
  return out
}

/** Value type used for a rule on a field with this sample value. */
function sampleType(v: unknown): EditableType {
  const t = bsonTypeOf(Array.isArray(v) && v.length ? v[0] : v)
  return isEditableType(t) && !['array', 'object', 'null'].includes(t) ? t : 'string'
}

function valuesAt(v: unknown, segs: string[], out: unknown[]): void {
  if (Array.isArray(v)) {
    if (segs.length && /^\d+$/.test(segs[0])) return valuesAt(v[Number(segs[0])], segs.slice(1), out)
    for (const x of v) valuesAt(x, segs, out)
    return
  }
  if (!segs.length) return void out.push(v)
  if (v !== null && typeof v === 'object' && bsonTypeOf(v) === 'object') valuesAt((v as Record<string, unknown>)[segs[0]], segs.slice(1), out)
}

/** Type of a field as seen in sample documents (array fields give their element type); undefined if unknown. */
export function knownFieldType(docs: Record<string, unknown>[], path: string): EditableType | undefined {
  if (!path) return undefined
  const segs = path.split('.')
  for (const d of docs) {
    const vals: unknown[] = []
    valuesAt(d, segs, vals)
    for (const v of vals) {
      if (v === null || v === undefined) continue
      const t = bsonTypeOf(v)
      return isEditableType(t) && t !== 'array' && t !== 'object' ? t : undefined
    }
  }
  return undefined
}

/** After the field name changes: preselect the known type while the user has not typed a value yet. */
export function withKnownType(r: Rule, docs: Record<string, unknown>[], prefix = ''): Rule {
  if (r.value !== '' || r.value2 !== '' || ['exists', 'notExists', 'isNull', 'notNull', 'type', 'notType', 'text'].includes(r.op)) return r
  const t = knownFieldType(docs, prefix ? `${prefix}.${r.field}` : r.field)
  return t && t !== r.valueType ? changeRuleType(r, t) : r
}

/** Rule for a field dropped on / added to the builder. */
export function ruleFromField(path: string, value: unknown, hasValue: boolean, docs: Record<string, unknown>[]): Rule {
  const r = newRule(path)
  if (hasValue) {
    const t = bsonTypeOf(value)
    if (!isEditableType(t) || t === 'array' || t === 'object') return { ...r, op: 'exists' }
    if (t === 'null') return { ...r, op: 'isNull' }
    return { ...r, valueType: t, value: editText(value) }
  }
  const known = knownFieldType(docs, path)
  if (known) return { ...r, valueType: known }
  const doc = docs.find((d) => hasPath(d, path))
  return doc ? { ...r, valueType: sampleType(getPath(doc, path)) } : r
}

/** Re-express value text in another type, keeping the text when it can't be converted. */
export function convertText(text: string, from: EditableType, to: EditableType): string {
  if (from === to || to === 'null' || from === 'null' || text === '') return text
  try {
    return editText(convertValue(parseTyped(text, from), to))
  } catch {
    return to === 'bool' ? 'false' : text
  }
}

/** Apply a value-type change to a rule: convert its values and drop an operator the new type doesn't support. */
export function changeRuleType(r: Rule, to: EditableType): Rule {
  const def = OPERATOR_BY_ID[r.op]
  const op = def.types && !def.types.includes(to) ? 'eq' : r.op
  const opnd = OPERATOR_BY_ID[op].operand
  const value =
    opnd === 'list' ? r.value.split('\n').map((l) => (l.trim() ? convertText(l, r.valueType, to) : l)).join('\n') : opnd === 'type' || opnd === 'text' ? r.value : convertText(r.value, r.valueType, to)
  return { ...r, op, valueType: to, value, value2: opnd === 'two' ? convertText(r.value2, r.valueType, to) : r.value2 }
}

/** Apply an operator change, adapting the value to the new operand kind. */
export function changeRuleOp(r: Rule, op: Rule['op']): Rule {
  const was = OPERATOR_BY_ID[r.op].operand
  const now = OPERATOR_BY_ID[op].operand
  let { value, valueType } = r
  if (was !== now) {
    if (now === 'type') value = 'string'
    else if (was === 'type' || was === 'text' || now === 'text') value = ''
    else if (was === 'list') value = value.split('\n').find((l) => l.trim()) ?? ''
  }
  const types = OPERATOR_BY_ID[op].types
  if (types && !types.includes(valueType)) valueType = 'string'
  return { ...r, op, value, valueType }
}
