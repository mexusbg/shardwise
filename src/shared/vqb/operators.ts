import type { EditableType } from '../bsonValue'
import type { GroupOp, OperatorId } from './types'

/** What kind of value input an operator needs. */
export type OperandKind = 'one' | 'two' | 'list' | 'none' | 'type' | 'text'

export interface OperatorDef {
  id: OperatorId
  label: string
  operand: OperandKind
  /** Value types this operator makes sense for; undefined = all. */
  types?: EditableType[]
}

const ORDERED: EditableType[] = ['string', 'int', 'long', 'double', 'decimal', 'date', 'objectId']
const RANGE: EditableType[] = ['int', 'long', 'double', 'decimal', 'date', 'objectId', 'string']

export const OPERATORS: OperatorDef[] = [
  { id: 'eq', label: 'equals', operand: 'one' },
  { id: 'ne', label: 'is not equal to', operand: 'one' },
  { id: 'lt', label: 'is less than (<)', operand: 'one', types: ORDERED },
  { id: 'lte', label: 'is less than or equal (<=)', operand: 'one', types: ORDERED },
  { id: 'gt', label: 'is greater than (>)', operand: 'one', types: ORDERED },
  { id: 'gte', label: 'is greater than or equal (>=)', operand: 'one', types: ORDERED },
  { id: 'range_gt_lt', label: 'is between (< … <)', operand: 'two', types: RANGE },
  { id: 'range_gt_lte', label: 'is between (< … <=)', operand: 'two', types: RANGE },
  { id: 'range_gte_lt', label: 'is between (<= … <)', operand: 'two', types: RANGE },
  { id: 'range_gte_lte', label: 'is between (<= … <=)', operand: 'two', types: RANGE },
  { id: 'in', label: 'is in', operand: 'list' },
  { id: 'nin', label: 'is not in', operand: 'list' },
  { id: 'all', label: 'contains all of', operand: 'list' },
  { id: 'contains', label: 'contains', operand: 'one', types: ['string'] },
  { id: 'notContains', label: 'does not contain', operand: 'one', types: ['string'] },
  { id: 'startsWith', label: 'starts with', operand: 'one', types: ['string'] },
  { id: 'notStartsWith', label: 'does not start with', operand: 'one', types: ['string'] },
  { id: 'endsWith', label: 'ends with', operand: 'one', types: ['string'] },
  { id: 'notEndsWith', label: 'does not end with', operand: 'one', types: ['string'] },
  { id: 'exists', label: 'exists', operand: 'none' },
  { id: 'notExists', label: 'is missing', operand: 'none' },
  { id: 'isNull', label: 'is null', operand: 'none' },
  { id: 'notNull', label: 'is not null', operand: 'none' },
  { id: 'type', label: 'has type', operand: 'type' },
  { id: 'notType', label: 'is not of type', operand: 'type' },
  { id: 'text', label: 'text search ($text)', operand: 'text' }
]

export const OPERATOR_BY_ID = Object.fromEntries(OPERATORS.map((o) => [o.id, o])) as Record<OperatorId, OperatorDef>

export const operatorsFor = (t: EditableType): OperatorDef[] =>
  OPERATORS.filter((o) => !o.types || o.types.includes(t))

export const STRING_MATCH_OPS: OperatorId[] = [
  'contains',
  'notContains',
  'startsWith',
  'notStartsWith',
  'endsWith',
  'notEndsWith'
]

export const GROUP_LABELS: Record<GroupOp, string> = {
  and: 'All conditions ($and)',
  or: 'Any condition ($or)',
  nor: 'No condition ($nor)',
  elemMatch: 'An array element matches ($elemMatch)',
  notElemMatch: 'No array element matches'
}

/** Joiner words between rules inside a group (used by text summaries). */
export const GROUP_JOINERS: Record<GroupOp, [string, string]> = {
  and: ['Where', 'And'],
  or: ['Either', 'Or'],
  nor: ['Neither', 'Nor'],
  elemMatch: ['With', 'And'],
  notElemMatch: ['With', 'And']
}
