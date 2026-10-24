import { useState } from 'react'
import type { DragEvent, ReactElement } from 'react'
import { OUTPUT_STAGES, STAGE_TEMPLATES, stageSummary } from '@shared/pipeline'
import type { Stage } from '@shared/pipeline'
import { showMenu } from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { Icon } from '../Icon'

export interface StageCount {
  n: number
  capped: boolean
}

export interface StageListActions {
  select: (id: string) => void
  setOp: (id: string, op: string) => void
  toggle: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
  insert: (index: number, op: string) => void
  move: (from: number, to: number) => void
}

const GROUPS: [StageTemplateGroup, string][] = [
  ['common', 'Common'],
  ['more', 'More stages'],
  ['atlas', 'Atlas'],
  ['output', 'Output']
]
type StageTemplateGroup = (typeof STAGE_TEMPLATES)[number]['group']

/** Operator picker menu: common stages inline, the rest in submenus. */
export function operatorMenu(onPick: (op: string) => void): MenuItem[] {
  const item = (op: string, info: string): MenuItem => ({ label: `${op}  —  ${info}`, onClick: () => onPick(op), danger: OUTPUT_STAGES.has(op) })
  const common = STAGE_TEMPLATES.filter((t) => t.group === 'common').map((t) => item(t.op, t.info))
  const subs = GROUPS.slice(1).map(([g, label]) => ({ label, submenu: STAGE_TEMPLATES.filter((t) => t.group === g).map((t) => item(t.op, t.info)) }))
  return [...common, { separator: true }, ...subs]
}

function OperatorSelect({ value, onChange }: { value: string; onChange: (op: string) => void }): ReactElement {
  const known = STAGE_TEMPLATES.some((t) => t.op === value)
  return (
    <select className="select small agg-op" value={value} onChange={(e) => onChange(e.target.value)} onClick={(e) => e.stopPropagation()} title="Stage operator">
      {!known && <option value={value}>{value}</option>}
      {GROUPS.map(([g, label]) => (
        <optgroup key={g} label={label}>
          {STAGE_TEMPLATES.filter((t) => t.group === g).map((t) => (
            <option key={t.op} value={t.op}>
              {t.op}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

const DND = 'application/x-shardwise-agg-stage'

export function StageList(p: {
  stages: Stage[]
  selectedId: string
  errors: Record<string, string>
  counts: Record<string, StageCount>
  sampleSize: number
  actions: StageListActions
}): ReactElement {
  const { stages, actions: a } = p
  const [drag, setDrag] = useState<number | null>(null)
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null)

  const onOver = (e: DragEvent, index: number): void => {
    if (drag === null || !e.dataTransfer.types.includes(DND)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > r.top + r.height / 2
    if (drop?.index !== index || drop.after !== after) setDrop({ index, after })
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    if (drag !== null && drop) {
      let to = drop.index + (drop.after ? 1 : 0)
      if (to > drag) to--
      if (to !== drag) a.move(drag, to)
    }
    setDrag(null)
    setDrop(null)
  }

  const cardMenu = (i: number, s: Stage): MenuItem[] => [
    { label: 'Insert Stage Before', icon: 'plus', submenu: operatorMenu((op) => a.insert(i, op)) },
    { label: 'Insert Stage After', icon: 'plus', submenu: operatorMenu((op) => a.insert(i + 1, op)) },
    { separator: true },
    { label: s.enabled ? 'Disable Stage' : 'Enable Stage', onClick: () => a.toggle(s.id) },
    { label: 'Duplicate Stage', icon: 'duplicate', onClick: () => a.duplicate(s.id) },
    { label: 'Move Up', disabled: i === 0, onClick: () => a.move(i, i - 1) },
    { label: 'Move Down', disabled: i === stages.length - 1, onClick: () => a.move(i, i + 1) },
    { separator: true },
    { label: 'Delete Stage', icon: 'trash', danger: true, onClick: () => a.remove(s.id) }
  ]

  return (
    <div className="agg-stages" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}>
      {stages.map((s, i) => {
        const err = p.errors[s.id]
        const count = p.counts[s.id]
        const cls = [
          'agg-card',
          s.id === p.selectedId && 'selected',
          !s.enabled && 'disabled',
          err && 'invalid',
          OUTPUT_STAGES.has(s.op) && 'output',
          drag === i && 'dragging',
          drop?.index === i && (drop.after ? 'drop-after' : 'drop-before')
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={s.id}
            className={cls}
            onClick={() => a.select(s.id)}
            onContextMenu={(e) => {
              a.select(s.id)
              showMenu(e, cardMenu(i, s))
            }}
            onDragOver={(e) => onOver(e, i)}
            onDrop={onDrop}
          >
            <div className="agg-card-head">
              <span
                className="drag-handle"
                draggable
                title="Drag to reorder"
                onDragStart={(e) => {
                  setDrag(i)
                  e.dataTransfer.setData(DND, s.id)
                  e.dataTransfer.effectAllowed = 'move'
                  const card = e.currentTarget.closest('.agg-card')
                  if (card) e.dataTransfer.setDragImage(card, 14, 14)
                }}
                onDragEnd={() => {
                  setDrag(null)
                  setDrop(null)
                }}
              >
                <Icon name="grip" size={14} />
              </span>
              <span className="agg-card-num">{i + 1}</span>
              <OperatorSelect value={s.op} onChange={(op) => a.setOp(s.id, op)} />
              {count && s.enabled && (
                <span className="agg-count" title={`Documents leaving this stage in the preview (sample of ${p.sampleSize} input documents)`}>
                  {count.n.toLocaleString()}
                  {count.capped ? '+' : ''}
                </span>
              )}
              <span className="spacer" />
              <span className="agg-card-actions">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  title={s.enabled ? 'Enabled — click to skip this stage' : 'Disabled — click to enable'}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => a.toggle(s.id)}
                />
                <button
                  className="btn ghost icon small"
                  title="Duplicate stage"
                  onClick={(e) => {
                    e.stopPropagation()
                    a.duplicate(s.id)
                  }}
                >
                  <Icon name="duplicate" size={13} />
                </button>
                <button
                  className="btn ghost icon small"
                  title="Delete stage"
                  onClick={(e) => {
                    e.stopPropagation()
                    a.remove(s.id)
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
                <button
                  className="btn ghost icon small"
                  title="Insert a stage after this one"
                  onClick={(e) => {
                    e.stopPropagation()
                    showMenu(e, operatorMenu((op) => a.insert(i + 1, op)))
                  }}
                >
                  <Icon name="plus" size={13} />
                </button>
              </span>
            </div>
            <div className="agg-card-summary" title={err ?? undefined}>
              {err && <Icon name="warn" size={12} className="agg-card-err" />}
              <code>{stageSummary(s) || '{}'}</code>
            </div>
          </div>
        )
      })}
      <button className="agg-add" onClick={(e) => showMenu(e, operatorMenu((op) => a.insert(stages.length, op)))}>
        <Icon name="plus" size={13} /> Add stage
      </button>
    </div>
  )
}
