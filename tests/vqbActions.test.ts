import { describe, expect, it } from 'vitest'
import { Int32, ObjectId } from 'bson'
import { newGroup, newProjectionItem, newRule } from '@shared/vqb/types'
import type { Group, Node } from '@shared/vqb/types'
import {
  addGroup,
  canMoveInto,
  changeRuleOp,
  changeRuleType,
  convertText,
  duplicateNode,
  findNode,
  insertNode,
  moveItem,
  moveNode,
  removeNode,
  ruleFromField,
  updateNode,
  knownFieldType,
  withKnownType
} from '@shared/vqb/tree'

const ids = (g: Group): string[] => g.children.map((c) => c.id)

function tree(): { root: Group; a: Node; b: Node; sub: Group; c: Node } {
  const a = newRule('a')
  const b = newRule('b')
  const c = newRule('c')
  const sub: Group = { ...newGroup('or'), children: [c] }
  return { root: { ...newGroup('and'), children: [a, b, sub] }, a, b, sub, c }
}

describe('tree updates', () => {
  it('updates a nested node immutably and keeps untouched subtrees', () => {
    const { root, c, a } = tree()
    const next = updateNode(root, c.id, (n) => ({ ...n, field: 'x' }) as Node)
    expect(next).not.toBe(root)
    expect((findNode(next, c.id) as { field: string }).field).toBe('x')
    expect((findNode(root, c.id) as { field: string }).field).toBe('c')
    expect(next.children[0]).toBe(a)
    expect(updateNode(root, 'missing', (n) => n)).toBe(root)
  })

  it('removes and duplicates nodes', () => {
    const { root, b, sub } = tree()
    expect(ids(removeNode(root, b.id))).not.toContain(b.id)
    const dup = duplicateNode(root, sub.id)
    expect(dup.children).toHaveLength(4)
    const copy = dup.children[3] as Group
    expect(copy.id).not.toBe(sub.id)
    expect(copy.children[0].id).not.toBe(sub.children[0].id)
    expect(copy.op).toBe('or')
  })

  it('adds groups with the opposite operator of an AND parent', () => {
    const { root, sub } = tree()
    expect((addGroup(root, root.id).children[3] as Group).op).toBe('or')
    expect(((findNode(addGroup(root, sub.id), sub.id) as Group).children[1] as Group).op).toBe('and')
  })

  it('moves within a group, adjusting for the removed slot', () => {
    const { root, a, b, sub } = tree()
    expect(ids(moveNode(root, a.id, root.id, 2))).toEqual([b.id, a.id, sub.id])
    expect(ids(moveNode(root, sub.id, root.id, 0))).toEqual([sub.id, a.id, b.id])
    expect(moveNode(root, a.id, root.id, 1)).toBe(root)
  })

  it('moves between groups', () => {
    const { root, a, c, sub } = tree()
    const next = moveNode(root, a.id, sub.id, 0)
    expect(ids(findNode(next, sub.id) as Group)).toEqual([a.id, c.id])
    expect(ids(next)).not.toContain(a.id)
    const out = moveNode(root, c.id, root.id)
    expect(ids(out).at(-1)).toBe(c.id)
  })

  it('refuses to move a group into itself or its descendants', () => {
    const { sub } = tree()
    const inner: Group = { ...newGroup('and'), children: [] }
    const root: Group = { ...newGroup('and'), children: [{ ...sub, children: [inner] }] }
    expect(canMoveInto(root, sub.id, inner.id)).toBe(false)
    expect(moveNode(root, sub.id, inner.id)).toBe(root)
    expect(moveNode(root, sub.id, sub.id)).toBe(root)
    expect(canMoveInto(root, inner.id, root.id)).toBe(true)
  })

  it('inserts at an index', () => {
    const { root, a } = tree()
    const r = newRule('z')
    expect(ids(insertNode(root, root.id, r, 1))[1]).toBe(r.id)
    expect(ids(insertNode(root, root.id, r))[3]).toBe(r.id)
    expect(ids(insertNode(root, root.id, r, 0))[1]).toBe(a.id)
  })
})

describe('moveItem', () => {
  const l = ['a', 'b', 'c'].map((f) => newProjectionItem(f))
  const f = (x: typeof l): string => x.map((i) => i.field).join('')
  it('reorders list items', () => {
    expect(f(moveItem(l, l[0].id, 3))).toBe('bca')
    expect(f(moveItem(l, l[2].id, 0))).toBe('cab')
    expect(f(moveItem(l, l[0].id, 2))).toBe('bac')
    expect(moveItem(l, l[1].id, 1)).toBe(l)
  })
})

describe('ruleFromField', () => {
  it('uses the dragged value and its type', () => {
    const r = ruleFromField('age', new Int32(42), true, [])
    expect(r).toMatchObject({ field: 'age', op: 'eq', valueType: 'int', value: '42' })
    const oid = new ObjectId()
    expect(ruleFromField('_id', oid, true, [])).toMatchObject({ valueType: 'objectId', value: oid.toHexString() })
  })

  it('uses exists for containers and isNull for null', () => {
    expect(ruleFromField('tags', ['a'], true, []).op).toBe('exists')
    expect(ruleFromField('sub', { x: 1 }, true, []).op).toBe('exists')
    expect(ruleFromField('n', null, true, []).op).toBe('isNull')
  })

  it('guesses the type from the first document having the field', () => {
    const docs = [{ x: 1 }, { when: new Date(), tags: [new Int32(3)], a: { b: true } }]
    expect(ruleFromField('when', undefined, false, docs)).toMatchObject({ op: 'eq', valueType: 'date', value: '' })
    expect(ruleFromField('tags', undefined, false, docs).valueType).toBe('int')
    expect(ruleFromField('a.b', undefined, false, docs).valueType).toBe('bool')
    expect(ruleFromField('nope', undefined, false, docs).valueType).toBe('string')
  })
})

describe('type / operator changes', () => {
  it('converts value text when possible, keeps it otherwise', () => {
    expect(convertText('42', 'string', 'int')).toBe('42')
    expect(convertText('abc', 'string', 'int')).toBe('abc')
    expect(convertText('abc', 'string', 'bool')).toBe('false')
    expect(convertText('5', 'int', 'string')).toBe('5')
  })

  it('drops operators the new type does not support', () => {
    const r = { ...newRule('n'), op: 'contains' as const, value: '12' }
    expect(changeRuleType(r, 'int')).toMatchObject({ op: 'eq', valueType: 'int', value: '12' })
    const range = { ...newRule('n'), op: 'range_gt_lt' as const, valueType: 'int' as const, value: '1', value2: '9' }
    expect(changeRuleType(range, 'double')).toMatchObject({ op: 'range_gt_lt', value: '1', value2: '9' })
  })

  it('adapts the value to the new operand kind', () => {
    const r = { ...newRule('n'), value: 'x' }
    expect(changeRuleOp(r, 'type').value).toBe('string')
    expect(changeRuleOp({ ...r, op: 'type', value: 'int' }, 'eq').value).toBe('')
    expect(changeRuleOp({ ...r, op: 'in', value: '\na\nb' }, 'eq').value).toBe('a')
    expect(changeRuleOp(r, 'in').value).toBe('x')
    expect(changeRuleOp({ ...r, valueType: 'bool' }, 'gt').valueType).toBe('string')
  })
})

describe('known field types', () => {
  const docs = [
    { _id: 1, age: null, name: 'x' },
    { _id: 2, age: new Int32(5), at: new Date(0), tags: ['a'], items: [{ qty: new Int32(1) }], nested: { id: new ObjectId() } }
  ]
  it('finds the type from the first non-null value, through arrays and objects', () => {
    expect(knownFieldType(docs, 'age')).toBe('int')
    expect(knownFieldType(docs, 'at')).toBe('date')
    expect(knownFieldType(docs, 'tags')).toBe('string')
    expect(knownFieldType(docs, 'items.qty')).toBe('int')
    expect(knownFieldType(docs, 'nested.id')).toBe('objectId')
    expect(knownFieldType(docs, 'nested')).toBeUndefined()
    expect(knownFieldType(docs, 'missing')).toBeUndefined()
  })
  it('preselects the type only while no value was typed', () => {
    expect(withKnownType({ ...newRule('at') }, docs).valueType).toBe('date')
    expect(withKnownType({ ...newRule('qty') }, docs, 'items').valueType).toBe('int')
    expect(withKnownType({ ...newRule('at'), value: 'abc' }, docs).valueType).toBe('string')
    expect(withKnownType({ ...newRule('at'), op: 'exists' }, docs).valueType).toBe('string')
  })
})
