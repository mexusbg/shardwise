import { createContext, useContext, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from 'react'
import { MONGO_TYPE_ALIASES } from '@shared/bsonValue'
import { OPERATOR_BY_ID, STRING_MATCH_OPS } from '@shared/vqb/operators'
import type { Group, GroupOp, Node, OperatorId, Rule } from '@shared/vqb/types'
import type { QueryTab } from '../../state/store'
import { Icon } from '../Icon'
import { ValueInput } from '../editing/ValueInput'
import { cls, DragHandle, MIME_NODE, useDrop } from './vqbDnd'
import type { FieldDrop } from './vqbDnd'
import { AddButton, ChipSelect, FieldChip, PillSelect, RowActions, Toggle, TYPE_COLOR, TypeBadge } from './vqbUi'
import type { Choice } from './vqbUi'
import {
  addGroup,
  addRule,
  canMoveInto,
  changeRuleOp,
  changeRuleType,
  duplicateNode,
  editVqb,
  insertNode,
  moveNode,
  removeNode,
  ruleFromField,
  seedRule,
  updateNode,
  withKnownType
} from './vqbActions'

interface Ctx {
  tab: QueryTab
  listId: string
  edit: (fn: (root: Group) => Group) => void
  /** Drop handlers placing a moved node / dropped field into `group` before `index` (end when omitted). */
  dropInto: (group: Group, index?: number) => Parameters<typeof useDrop>[0]
}

const QCtx = createContext<Ctx | null>(null)
const useQ = (): Ctx => useContext(QCtx)!

const OP_GROUPS: { label: string; ops: [OperatorId, string, string][] }[] = [
  {
    label: 'Compare',
    ops: [
      ['eq', 'is', '$eq'],
      ['ne', 'is not', '$ne'],
      ['gt', 'greater than', '$gt'],
      ['gte', 'greater or equal', '$gte'],
      ['lt', 'less than', '$lt'],
      ['lte', 'less or equal', '$lte']
    ]
  },
  {
    label: 'Range',
    ops: [
      ['range_gte_lte', 'between [a, b]', '$gte … $lte'],
      ['range_gt_lt', 'between (a, b)', '$gt … $lt'],
      ['range_gte_lt', 'between [a, b)', '$gte … $lt'],
      ['range_gt_lte', 'between (a, b]', '$gt … $lte']
    ]
  },
  {
    label: 'List',
    ops: [
      ['in', 'is one of', '$in'],
      ['nin', 'is none of', '$nin'],
      ['all', 'has all of', '$all']
    ]
  },
  {
    label: 'Text',
    ops: [
      ['contains', 'contains', '$regex'],
      ['notContains', "doesn't contain", '$not $regex'],
      ['startsWith', 'starts with', '$regex ^…'],
      ['notStartsWith', "does not start with", '$not $regex ^…'],
      ['endsWith', 'ends with', '$regex …$'],
      ['notEndsWith', "doesn't end with", '$not $regex …$']
    ]
  },
  {
    label: 'Presence',
    ops: [
      ['exists', 'exists', '$exists: true'],
      ['notExists', 'is missing', '$exists: false'],
      ['isNull', 'is null', '$eq: null'],
      ['notNull', 'is not null', '$ne: null']
    ]
  },
  {
    label: 'Type',
    ops: [
      ['type', 'has type', '$type'],
      ['notType', 'is not of type', '$not $type']
    ]
  },
  { label: 'Search', ops: [['text', 'matches text search', '$text']] }
]

const OP_HINT = Object.fromEntries(OP_GROUPS.flatMap((g) => g.ops.map(([id, , hint]) => [id, hint]))) as Record<OperatorId, string>

const MODES: Choice<GroupOp>[] = [
  { value: 'and', label: 'All', title: 'every condition matches ($and)' },
  { value: 'or', label: 'Any', title: 'at least one condition matches ($or)' },
  { value: 'nor', label: 'None', title: 'no condition matches ($nor)' }
]
const ARRAY_MODE: Choice<GroupOp> = { value: 'elemMatch', label: 'Array', title: 'conditions on the elements of an array field ($elemMatch)' }
const ARRAY_OPS: Choice<GroupOp>[] = [
  { value: 'elemMatch', label: 'has an element where', title: '$elemMatch' },
  { value: 'notElemMatch', label: 'has no element where', title: '$not: { $elemMatch }' }
]
const RAILS = ['var(--leaf)', 'var(--t-number)', 'var(--t-bool)', 'var(--t-date)']

const isArrayOp = (op: GroupOp): boolean => op === 'elemMatch' || op === 'notElemMatch'

export const countRules = (g: Group): number => g.children.reduce((n, c) => n + (c.kind === 'rule' ? 1 : countRules(c)), 0)

export function QueryTree({ tab, listId }: { tab: QueryTab; listId: string }): ReactElement {
  const edit: Ctx['edit'] = (fn) => editVqb(tab.id, (v) => ({ root: fn(v.root) }))
  const dropInto: Ctx['dropInto'] = (g, index) => ({
    mime: MIME_NODE,
    canMove: (id) => canMoveInto(tab.vqb.root, id, g.id),
    onMove: (id) => edit((r) => moveNode(r, id, g.id, index)),
    onField: (f: FieldDrop) => edit((r) => insertNode(r, g.id, seedRule(ruleFromField(f.path, f.value, f.hasValue, tab.docs ?? [])), index))
  })
  return (
    <QCtx.Provider value={{ tab, listId, edit, dropInto }}>
      <GroupBlock group={tab.vqb.root} depth={0} />
    </QCtx.Provider>
  )
}

function NodeActions({ node, what }: { node: Node; what: string }): ReactElement {
  const { edit } = useQ()
  return (
    <RowActions
      what={what}
      enabled={node.enabled}
      onEnabled={(enabled) => edit((r) => updateNode(r, node.id, (n) => ({ ...n, enabled })))}
      onDuplicate={() => edit((r) => duplicateNode(r, node.id))}
      onRemove={() => edit((r) => removeNode(r, node.id))}
    />
  )
}

const NO_DROP: Parameters<typeof useDrop>[0] = { mime: MIME_NODE, canMove: () => false, onMove: () => {}, onField: () => {} }

function AddButtons({ group }: { group: Group }): ReactElement {
  const { edit } = useQ()
  return (
    <>
      <AddButton label="Condition" title="Add a condition to this group" onClick={() => edit((r) => addRule(r, group.id))} />
      <AddButton label="Group" title="Add a nested group" onClick={() => edit((r) => addGroup(r, group.id))} />
    </>
  )
}

function GroupBlock({ group: g, parent, depth }: { group: Group; parent?: Group; depth: number }): ReactElement {
  const { tab, listId, edit, dropInto } = useQ()
  const index = parent?.children.findIndex((c) => c.id === g.id)
  const [overHead, headDrop] = useDrop(parent ? dropInto(parent, index) : NO_DROP)
  const [overEnd, endDrop] = useDrop(dropInto(g))
  const set = (p: Partial<Group>): void => edit((r) => updateNode(r, g.id, (n) => ({ ...n, ...p }) as Group))
  const err = tab.vqb.errorRuleId === g.id
  const arr = isArrayOp(g.op)
  const empty = !g.children.length
  const mode = arr ? ARRAY_MODE : (MODES.find((m) => m.value === g.op) ?? MODES[0])
  const addCond = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) edit((r) => addRule(r, g.id))
  }
  return (
    <div
      className={cls('vqb-grp', !parent && 'root', arr && 'array', empty && 'empty', !g.enabled && 'disabled', err && 'error', overHead && 'drop-before')}
      style={{ '--rail': err ? 'var(--danger)' : RAILS[depth % RAILS.length] } as CSSProperties}
    >
      {(parent || !empty) && (
        <div className="vqb-grp-head" {...(parent ? headDrop : {})}>
          {parent && <DragHandle mime={MIME_NODE} id={g.id} title="Drag to move this group" />}
          {parent && <NodeActions node={g} what="group" />}
          <PillSelect
            value={arr ? 'elemMatch' : g.op}
            label={mode.label}
            title={`Match when ${mode.title}`}
            options={parent ? [...MODES, ARRAY_MODE] : MODES}
            onChange={(op) => !(arr && op === 'elemMatch') && set({ op })}
          />
          {arr ? (
            <>
              <FieldChip value={g.field ?? ''} listId={listId} placeholder="array field" onChange={(field) => set({ field })} />
              <ChipSelect className="vqb-arrop" value={g.op} groups={[{ options: ARRAY_OPS }]} onChange={(op) => set({ op })} />
            </>
          ) : (
            <span className="vqb-hint">of the following</span>
          )}
        </div>
      )}
      {err && <div className="vqb-error">{tab.vqb.errorMessage}</div>}
      <div className="vqb-grp-body">
        {g.children.map((c, i) => (c.kind === 'rule' ? <RuleRow key={c.id} rule={c} parent={g} index={i} /> : <GroupBlock key={c.id} group={c} parent={g} depth={depth + 1} />))}
        {empty ? (
          <div className={cls('vqb-drop', 'vqb-empty', overEnd && 'over')} {...endDrop} onDoubleClick={addCond} title="Drop a field here, or double-click to add an empty condition">
            <Icon name="filter" size={13} />
            <span className="grow ellipsis">{arr ? 'Drop an element field' : parent ? 'Drop a field here' : 'Drag a column or cell here'}</span>
            <AddButtons group={g} />
          </div>
        ) : (
          <div className={cls('vqb-foot', 'vqb-drop', overEnd && 'over')} {...endDrop} onDoubleClick={addCond}>
            <AddButtons group={g} />
            {overEnd && <span className="vqb-foot-hint">Drop to add here</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function RuleRow({ rule: r, parent, index }: { rule: Rule; parent: Group; index: number }): ReactElement {
  const { tab, listId, edit, dropInto } = useQ()
  const [over, drop] = useDrop(dropInto(parent, index))
  const set = (fn: (x: Rule) => Rule): void => edit((root) => updateNode(root, r.id, (n) => fn(n as Rule)))
  const err = tab.vqb.errorRuleId === r.id
  const inArray = isArrayOp(parent.op)
  const groups = OP_GROUPS.map((g) => ({
    label: g.label,
    options: g.ops
      .filter(([id]) => {
        const types = OPERATOR_BY_ID[id].types
        return id === r.op || !types || types.includes(r.valueType)
      })
      .map(([value, label, title]) => ({ value, label, title }))
  })).filter((g) => g.options.length)
  return (
    <div className={cls('vqb-rule', !r.enabled && 'disabled', err && 'error', over && 'drop-before')} {...drop}>
      <DragHandle mime={MIME_NODE} id={r.id} title="Drag to move this condition" />
      <div className="vqb-line">
        <NodeActions node={r} what="condition" />
        {r.op === 'text' ? (
          <span className="vqb-field static" title="$text uses the collection's text index">
            text index
          </span>
        ) : (
          <FieldChip
            value={r.field}
            listId={listId}
            placeholder={inArray ? 'element field' : 'field'}
            onChange={(field) => set((x) => seedRule(withKnownType({ ...x, field }, tab.docs ?? [], inArray ? (parent.field ?? '') : '')))}
          />
        )}
        <ChipSelect className="vqb-op" value={r.op} groups={groups} title={OP_HINT[r.op]} onChange={(op) => set((x) => changeRuleOp(x, op))} />
        {operand(r, set, err)}
      </div>
      {err && <div className="vqb-error">{tab.vqb.errorMessage}</div>}
    </div>
  )
}

/** Value controls for the operand kind, inline after the operator; the flex line wraps them only when out of room. */
function operand(r: Rule, set: (fn: (x: Rule) => Rule) => void, invalid: boolean): ReactNode {
  const patch = (p: Partial<Rule>): void => set((x) => ({ ...x, ...p }))
  const badge = <TypeBadge value={r.valueType} onChange={(t) => set((x) => seedRule(changeRuleType(x, t)))} />
  const wide = r.valueType === 'date' || r.valueType === 'objectId' || r.valueType === 'array' || r.valueType === 'object'
  const input = (text: string, key: 'value' | 'value2', placeholder?: string): ReactElement => (
    <span className="vqb-in">
      <ValueInput small type={r.valueType} text={text} invalid={invalid} placeholder={placeholder} onChange={(t) => patch({ [key]: t })} />
    </span>
  )
  switch (OPERATOR_BY_ID[r.op].operand) {
    case 'none':
      return null
    case 'one':
      return (
        <>
          <span className={cls('vqb-val', wide && 'wide')}>
            {badge}
            {input(r.value, 'value', r.valueType === 'string' ? 'value' : undefined)}
          </span>
          {STRING_MATCH_OPS.includes(r.op) && (
            <Toggle on={r.caseInsensitive} title="Match upper and lower case alike ($options: 'i')" onChange={(caseInsensitive) => patch({ caseInsensitive })}>
              any case
            </Toggle>
          )}
        </>
      )
    case 'two':
      return (
        <span className={cls('vqb-val', 'range', wide && 'wide')}>
          {badge}
          {input(r.value, 'value', 'from')}
          <span className="vqb-word">and</span>
          {input(r.value2, 'value2', 'to')}
        </span>
      )
    case 'list':
      return (
        <span className="vqb-val list">
          {badge}
          <Tokens rule={r} invalid={invalid} onChange={(v) => patch({ value: v })} />
        </span>
      )
    case 'type':
      return (
        <ChipSelect
          className="vqb-alias"
          value={r.value}
          groups={[{ options: (MONGO_TYPE_ALIASES.includes(r.value) ? MONGO_TYPE_ALIASES : [r.value, ...MONGO_TYPE_ALIASES]).map((t) => ({ value: t, label: t })) }]}
          onChange={(v) => patch({ value: v })}
        />
      )
    case 'text':
      return (
        <>
          <span className="vqb-val">
            <input className="input small grow" placeholder="words to search" value={r.value} onChange={(e) => patch({ value: e.target.value })} />
          </span>
          <input className="input small vqb-lang" placeholder="language" title="Text search language (optional)" value={r.textLanguage ?? ''} onChange={(e) => patch({ textLanguage: e.target.value || undefined })} />
          <Toggle on={!!r.textCaseSensitive} onChange={(v) => patch({ textCaseSensitive: v || undefined })}>
            case sensitive
          </Toggle>
          <Toggle on={!!r.textDiacriticSensitive} onChange={(v) => patch({ textDiacriticSensitive: v || undefined })}>
            diacritic sensitive
          </Toggle>
        </>
      )
  }
}

// List values are stored one per line (see listValues in filter.ts); a trailing empty line is dropped there.
function splitTokens(r: Rule): string[] {
  if (r.value === '') return []
  if (r.valueType !== 'string') return r.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  const lines = r.value.split('\n')
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

const joinTokens = (t: string[]): string => t.join('\n') + (t.length && t[t.length - 1] === '' ? '\n' : '')

function Tokens({ rule: r, invalid, onChange }: { rule: Rule; invalid: boolean; onChange: (value: string) => void }): ReactElement {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const tokens = splitTokens(r)
  const parts = (text: string): string[] => (r.valueType === 'string' ? text.split(/\r?\n/) : text.split(/[\r\n,]/).map((s) => s.trim())).filter((s) => s !== '')
  const commit = (text: string): void => {
    const add = parts(text)
    if (add.length) onChange(joinTokens([...tokens, ...add]))
    setDraft('')
  }
  const removeAt = (i: number): void => onChange(joinTokens(tokens.filter((_, j) => j !== i)))
  return (
    <div className={cls('vqb-tokens', invalid && 'invalid')} style={{ '--tc': TYPE_COLOR[r.valueType] } as CSSProperties} onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
      {tokens.map((t, i) => (
        <span key={i} className="vqb-token">
          <button
            className="vqb-token-text"
            title="Click to edit"
            onClick={() => {
              removeAt(i)
              setDraft(t)
              input.current?.focus()
            }}
          >
            {t === '' ? '""' : t}
          </button>
          <button className="vqb-token-x" aria-label={`Remove ${t}`} onClick={() => removeAt(i)}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        className="vqb-token-input"
        spellCheck={false}
        placeholder={tokens.length ? 'add…' : r.valueType === 'string' ? 'type a value, Enter to add' : 'values, Enter or comma to add'}
        value={draft}
        onChange={(e) => {
          const t = e.target.value
          if (r.valueType !== 'string' && t.includes(',')) commit(t)
          else setDraft(t)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && draft === '' && tokens.length) {
            e.preventDefault()
            setDraft(tokens[tokens.length - 1])
            onChange(joinTokens(tokens.slice(0, -1)))
          }
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text')
          if (/[\r\n]/.test(t)) {
            e.preventDefault()
            commit(draft + t)
          }
        }}
        onBlur={() => draft.trim() !== '' && commit(draft)}
      />
    </div>
  )
}
