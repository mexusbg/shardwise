import type { EditableType } from '../bsonValue'

export type OperatorId =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'range_gt_lt'
  | 'range_gt_lte'
  | 'range_gte_lt'
  | 'range_gte_lte'
  | 'in'
  | 'nin'
  | 'all'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'notStartsWith'
  | 'endsWith'
  | 'notEndsWith'
  | 'exists'
  | 'notExists'
  | 'isNull'
  | 'notNull'
  | 'type'
  | 'notType'
  | 'text'

export type GroupOp = 'and' | 'or' | 'nor' | 'elemMatch' | 'notElemMatch'

export interface Rule {
  kind: 'rule'
  id: string
  enabled: boolean
  field: string
  op: OperatorId
  valueType: EditableType
  /** Value as typed by the user. For list operators: one entry per line. For type operators: the $type alias. */
  value: string
  /** Upper bound for range operators. */
  value2: string
  caseInsensitive: boolean
  textLanguage?: string
  textCaseSensitive?: boolean
  textDiacriticSensitive?: boolean
}

export interface Group {
  kind: 'group'
  id: string
  enabled: boolean
  op: GroupOp
  /** Array field for elemMatch / notElemMatch groups. */
  field?: string
  children: Node[]
}

export type Node = Rule | Group

export interface ProjectionItem {
  id: string
  enabled: boolean
  field: string
  mode: 'include' | 'exclude' | 'slice'
  /** For slice: `5`, `-5` or `[skip, limit]`. */
  slice: string
}

export interface SortItem {
  id: string
  enabled: boolean
  field: string
  dir: 1 | -1
}

let seq = 0
export const nid = (): string => `n${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const newRule = (field = ''): Rule => ({
  kind: 'rule',
  id: nid(),
  enabled: true,
  field,
  op: 'eq',
  valueType: 'string',
  value: '',
  value2: '',
  caseInsensitive: false
})

export const newGroup = (op: GroupOp = 'and', field?: string): Group => ({
  kind: 'group',
  id: nid(),
  enabled: true,
  op,
  field,
  children: []
})

export const newProjectionItem = (field = '', mode: ProjectionItem['mode'] = 'include'): ProjectionItem => ({
  id: nid(),
  enabled: true,
  field,
  mode,
  slice: ''
})

export const newSortItem = (field = '', dir: 1 | -1 = 1): SortItem => ({ id: nid(), enabled: true, field, dir })

export class VqbValueError extends Error {
  constructor(
    message: string,
    public ruleId: string
  ) {
    super(message)
  }
}
