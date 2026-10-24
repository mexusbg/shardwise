import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { bsonTypeOf, isPlainDoc, shellText } from '@shared/bsonValue'
import { prefDocText } from '../../lib/docText'
import type { Doc } from '@shared/api'
import { CHANGE_OPS, CHANGE_SOURCES } from '@shared/changeHistoryApi'
import type {
  ChangeBatchInfo,
  ChangeHistorySettings as Settings,
  ChangeOp,
  ChangePathDiff,
  ChangeQuery,
  ChangeRecordDetail,
  ChangeRecordInfo,
  ChangeSource,
  PurgeRequest,
  RestorePlan,
  RestoreSelection
} from '@shared/changeHistoryApi'
import { api } from '../../lib/api'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog, Modal, openModal, promptDialog } from '../Modal'
import { showMenu } from '../ContextMenu'
import { changesApi } from './changesClient'
import { ChangeHistorySettings } from './ChangeHistorySettings'
import { bytes, fullTime, num, OP_LABEL, relTime, SOURCE_LABEL } from './format'
import './changes.css'

const PAGE = 200
const DAY = 86_400_000

type Current = { kind: 'batch'; batchId: string } | { kind: 'record'; id: number; batchId: string } | null

const idText = (v: unknown): string => {
  const s = shellText(v)
  return s.length > 60 ? `${s.slice(0, 57)}…` : s
}
const plural = (n: number, w: string): string => `${num(n)} ${w}${n === 1 ? '' : 's'}`

function OpChip({ op, n }: { op: ChangeOp; n?: number }): ReactElement {
  return (
    <span className={`chv-op op-${op}`}>
      {OP_LABEL[op]}
      {n !== undefined && n > 1 && <b>{num(n)}</b>}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Document panes
// ---------------------------------------------------------------------------

interface Line {
  depth: number
  path: string
  label?: string
  open?: string
  close?: string
  value?: unknown
  leaf?: boolean
  comma: boolean
}

function buildLines(doc: Doc): Line[] {
  const out: Line[] = []
  const walk = (v: unknown, label: string | undefined, path: string, depth: number, comma: boolean): void => {
    const arr = Array.isArray(v)
    const entries: [string, unknown][] = arr ? (v as unknown[]).map((x, i) => [String(i), x]) : isPlainDoc(v) ? Object.entries(v) : []
    if ((arr || isPlainDoc(v)) && entries.length) {
      out.push({ depth, path, label, open: arr ? '[' : '{', comma: false })
      entries.forEach(([k, x], i) => walk(x, arr ? undefined : k, path ? `${path}.${k}` : k, depth + 1, i < entries.length - 1))
      out.push({ depth, path, close: arr ? ']' : '}', comma })
    } else out.push({ depth, path, label, value: v, leaf: true, comma })
  }
  walk(doc, undefined, '', 0, false)
  return out
}

type Mark = 'added' | 'removed' | 'changed' | 'since' | 'inner'

function marker(marks: { path: string; mark: Mark }[]): (path: string) => Mark | undefined {
  const exact = new Map(marks.map((m) => [m.path, m.mark]))
  const inner = new Set<string>()
  for (const m of marks) {
    const segs = m.path.split('.')
    for (let i = 1; i < segs.length; i++) inner.add(segs.slice(0, i).join('.'))
  }
  return (path) => {
    if (!path) return undefined
    const m = exact.get(path)
    if (m) return m
    const segs = path.split('.')
    for (let i = segs.length - 1; i > 0; i--) {
      const up = exact.get(segs.slice(0, i).join('.'))
      if (up) return up
    }
    return inner.has(path) ? 'inner' : undefined
  }
}

const GUTTER: Record<Mark, string> = { added: '+', removed: '−', changed: '~', since: '!', inner: '·' }
const MARK_TITLE: Record<Exclude<Mark, 'inner'>, string> = {
  added: 'added by this change',
  removed: 'removed by this change',
  changed: 'changed by this change',
  since: 'changed after this change was recorded'
}

function DocPane(props: { title: string; hint?: string; tone: 'before' | 'current' | 'after'; doc: Doc | null | undefined; marks: { path: string; mark: Mark }[]; empty: ReactNode }): ReactElement {
  const lines = useMemo(() => (props.doc ? buildLines(props.doc) : []), [props.doc])
  const markOf = useMemo(() => marker(props.marks), [props.marks])
  return (
    <div className={`chv-pane tone-${props.tone}`}>
      <div className="chv-pane-head">
        <span className="chv-pane-dot" />
        <span className="chv-pane-title">{props.title}</span>
        {props.hint && <span className="faint ellipsis">{props.hint}</span>}
      </div>
      <div className="chv-code selectable">
        {!props.doc && <div className="chv-pane-empty">{props.empty}</div>}
        {lines.map((l, i) => {
          const m = markOf(l.path)
          return (
            <div key={i} className={`chv-line ${m ? `mk-${m}` : ''}`} title={m && m !== 'inner' ? `${l.path}: ${MARK_TITLE[m]}` : undefined}>
              <span className="chv-gutter">{m ? GUTTER[m] : ''}</span>
              <span style={{ paddingLeft: l.depth * 14 }}>
                {l.label !== undefined && (
                  <>
                    <span className="chv-key">{l.label}</span>
                    <span className="faint">: </span>
                  </>
                )}
                {l.open}
                {l.close}
                {l.leaf && <span className={`t-${bsonTypeOf(l.value)}`}>{shellText(l.value)}</span>}
                {l.comma && <span className="faint">,</span>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const pick = (diffs: ChangePathDiff[], kinds: ChangePathDiff['kind'][]): { path: string; mark: Mark }[] =>
  diffs.filter((d) => kinds.includes(d.kind)).map((d) => ({ path: d.path, mark: d.kind }))

// ---------------------------------------------------------------------------
// Restore confirmation
// ---------------------------------------------------------------------------

function IssueList({ title, items, tone }: { title: string; items: RestorePlan['conflicts']; tone: 'warn' | 'muted' }): ReactElement | null {
  if (!items.length) return null
  return (
    <div className={`chv-issues ${tone}`}>
      <div className="chv-issues-head">
        {tone === 'warn' && <Icon name="warn" size={13} />}
        {title} <span className="badge">{num(items.length)}</span>
      </div>
      <div className="chv-issues-list">
        {items.slice(0, 50).map((i) => (
          <div key={i.id} className="chv-issue">
            <span className="mono ellipsis">{idText(i.docId)}</span>
            <span className="faint ellipsis">{i.reason}</span>
          </div>
        ))}
        {items.length > 50 && <div className="faint chv-issue">… and {num(items.length - 50)} more</div>}
      </div>
    </div>
  )
}

function confirmRestore(plan: RestorePlan, what: string): Promise<'safe' | 'force' | null> {
  const conflicts = plan.conflicts.length
  const clean = plan.documents - conflicts
  return openModal<'safe' | 'force' | null>((close) => (
    <Modal
      title="Restore documents"
      icon="history"
      onClose={() => close(null)}
      width={560}
      footer={
        <>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          {conflicts > 0 && (
            <button className="btn danger" onClick={() => close('force')}>
              Restore all, overwrite {plural(conflicts, 'conflict')}
            </button>
          )}
          <button className="btn primary" autoFocus disabled={clean <= 0} onClick={() => close('safe')}>
            {conflicts ? `Restore ${plural(clean, 'document')}` : 'Restore'}
          </button>
        </>
      }
    >
      <div className="chv-plan">
        <div>
          Restore {what}: <b>{plural(plan.documents, 'document')}</b>
          {plan.records !== plan.documents && <span className="muted"> from {plural(plan.records, 'change')}</span>}.
        </div>
        <div className="chv-plan-actions">
          {plan.actions.replace > 0 && (
            <span>
              <b>{num(plan.actions.replace)}</b> put back to the previous version
            </span>
          )}
          {plan.actions.reinsert > 0 && (
            <span>
              <b>{num(plan.actions.reinsert)}</b> re-inserted
            </span>
          )}
          {plan.actions.remove > 0 && (
            <span>
              <b>{num(plan.actions.remove)}</b> removed (they were inserted)
            </span>
          )}
        </div>
        <IssueList title="Changed since — restoring overwrites newer edits" items={plan.conflicts} tone="warn" />
        <IssueList title="Skipped" items={plan.skipped} tone="muted" />
        <div className="muted">The restore is recorded too, so it can be undone from this history.</div>
      </div>
    </Modal>
  ))
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function CollectionHistoryView({ tab }: { tab: ToolTab }): ReactElement {
  const active = useStore((s) => s.activeTab === tab.id)
  const [colls, setColls] = useState<string[]>([])
  const [coll, setColl] = useState(tab.coll ?? '')
  const [op, setOp] = useState<ChangeOp | ''>('')
  const [source, setSource] = useState<ChangeSource | ''>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [batches, setBatches] = useState<ChangeBatchInfo[] | null>(null)
  const [records, setRecords] = useState<Map<string, ChangeRecordInfo[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selBatches, setSelBatches] = useState<Set<string>>(new Set())
  const [selRecords, setSelRecords] = useState<Set<number>>(new Set())
  const [current, setCurrent] = useState<Current>(null)
  const [detail, setDetail] = useState<ChangeRecordDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gear, setGear] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const gearRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const pending = useRef(new Set<string>())

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250)
    return () => clearTimeout(t)
  }, [text])

  const query: ChangeQuery = useMemo(
    () => ({
      db: tab.db,
      coll: coll || undefined,
      op: op || undefined,
      source: source || undefined,
      from: from ? new Date(`${from}T00:00:00`) : undefined,
      to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + DAY - 1) : undefined,
      text: debounced || undefined
    }),
    [tab.db, coll, op, source, from, to, debounced]
  )
  const filtered = !!(op || source || from || to || debounced)

  const load = useCallback(async (): Promise<void> => {
    const my = ++seq.current
    setLoading(true)
    try {
      const list = await changesApi.changesBatches(tab.connId, { ...query, limit })
      if (my !== seq.current) return
      setBatches(list)
      setError(null)
      setRecords(new Map())
      const keep = new Set(list.map((b) => b.batchId))
      setExpanded((s) => new Set([...s].filter((b) => keep.has(b))))
      setSelBatches((s) => new Set([...s].filter((b) => keep.has(b))))
    } catch (e) {
      if (my === seq.current) setError(errorText(e))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [tab.connId, query, limit])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  useEffect(() => {
    api.listCollections(tab.connId, tab.db).then(
      (l) => setColls(l.filter((c) => c.type !== 'view').map((c) => c.name)),
      () => setColls([])
    )
    changesApi.changesGetSettings().then(setSettings, () => {})
  }, [tab.connId, tab.db])

  // Records of expanded batches (reloaded with the list).
  useEffect(() => {
    for (const b of expanded) {
      const key = `${seq.current}|${b}`
      if (records.has(b) || pending.current.has(key)) continue
      pending.current.add(key)
      changesApi
        .changesRecords(tab.connId, b, { ...query, limit: 5000 })
        .then(
          (list) => key.startsWith(`${seq.current}|`) && setRecords((m) => new Map(m).set(b, list)),
          (e) => toast(errorText(e), 'error')
        )
        .finally(() => pending.current.delete(key))
    }
  }, [expanded, records, tab.connId, query])

  const loadDetail = useCallback(async (id: number): Promise<void> => {
    setDetailError(null)
    try {
      setDetail(await changesApi.changesDetail(tab.connId, id))
    } catch (e) {
      setDetail(null)
      setDetailError(errorText(e))
    }
  }, [tab.connId])

  useEffect(() => {
    if (current?.kind === 'record') void loadDetail(current.id)
    else setDetail(null)
  }, [current, loadDetail])

  useEffect(() => {
    if (!gear) return
    const onDown = (e: MouseEvent): void => {
      if (!gearRef.current?.contains(e.target as Node)) setGear(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [gear])

  const toggleExpand = (b: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(b)) n.delete(b)
      else n.add(b)
      return n
    })
  const toggleBatch = (b: string): void =>
    setSelBatches((s) => {
      const n = new Set(s)
      if (n.has(b)) n.delete(b)
      else n.add(b)
      return n
    })
  const toggleRecord = (id: number): void =>
    setSelRecords((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const clearSelection = (): void => {
    setSelBatches(new Set())
    setSelRecords(new Set())
  }

  const selection: RestoreSelection = { ids: [...selRecords], batchIds: [...selBatches] }
  const selCount = selRecords.size + selBatches.size
  const currentBatch = current ? (batches ?? []).find((b) => b.batchId === current.batchId) : undefined

  const restore = async (sel: RestoreSelection, what: string): Promise<void> => {
    setBusy(true)
    try {
      const plan = await changesApi.changesRestorePlan(tab.connId, sel)
      setBusy(false)
      if (!plan.documents) {
        toast(plan.skipped.length ? `Nothing to restore: ${plan.skipped[0].reason.toLowerCase()}${plan.skipped.length > 1 ? ` (and ${num(plan.skipped.length - 1)} more)` : ''}` : 'Nothing to restore', 'info')
        return
      }
      const choice = await confirmRestore(plan, what)
      if (!choice) return
      setBusy(true)
      const r = await changesApi.changesRestore(tab.connId, sel, choice === 'force')
      const parts = [`${plural(r.restored, 'document')} restored`]
      if (r.conflicts.length) parts.push(`${num(r.conflicts.length)} left (changed since)`)
      if (r.failed.length) parts.push(`${num(r.failed.length)} failed: ${r.failed[0].reason}`)
      toast(parts.join(', '), r.failed.length ? 'error' : 'success')
      clearSelection()
      await load()
      if (current?.kind === 'record') void loadDetail(current.id)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const purge = async (req: PurgeRequest, message: ReactNode): Promise<void> => {
    const ok = await confirmDialog({ title: 'Purge Change History', message, confirmLabel: 'Purge', danger: true })
    if (!ok) return
    try {
      const n = await changesApi.changesPurge(tab.connId, req)
      toast(`${plural(n, 'change')} purged`, 'success')
      clearSelection()
      setCurrent(null)
      await load()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const scopeName = coll ? `${tab.db}.${coll}` : `every collection of ${tab.db}`

  const purgeMenu = (e: React.MouseEvent): void =>
    showMenu(e, [
      {
        label: `Selected (${num(selCount)})`,
        icon: 'trash',
        disabled: !selCount,
        onClick: () =>
          void (async () => {
            if (selBatches.size) await purge({ kind: 'batches', batchIds: [...selBatches] }, <>Remove the {plural(selBatches.size, 'selected operation')} from the history?</>)
            if (selRecords.size) await purge({ kind: 'ids', ids: [...selRecords] }, <>Remove the {plural(selRecords.size, 'selected document change')} from the history?</>)
          })()
      },
      {
        label: 'Older than…',
        icon: 'history',
        onClick: () =>
          void (async () => {
            const v = await promptDialog({
              title: 'Purge older changes',
              label: 'Older than (days)',
              initial: '7',
              confirmLabel: 'Continue',
              validate: (s) => (/^\d+$/.test(s.trim()) ? null : 'Enter a number of days')
            })
            if (v === null) return
            const days = Number(v.trim())
            await purge({ kind: 'olderThan', before: new Date(Date.now() - days * DAY), db: tab.db, coll: coll || undefined }, <>Remove changes of <b>{scopeName}</b> older than {plural(days, 'day')}?</>)
          })()
      },
      { separator: true },
      {
        label: `All for ${coll || tab.db}`,
        icon: 'trash',
        danger: true,
        onClick: () => void purge({ kind: 'scope', db: tab.db, coll: coll || undefined }, <>Remove <b>all</b> recorded changes of <b>{scopeName}</b>? They can no longer be restored.</>)
      }
    ])

  const copyJson = async (doc: Doc | null | undefined, what: string): Promise<void> => {
    if (!doc) return
    await api.copyText(prefDocText(doc))
    toast(`${what} copied`, 'success')
  }

  const batchRow = (b: ChangeBatchInfo): ReactElement => {
    const open = expanded.has(b.batchId)
    const isCur = current?.kind === 'batch' && current.batchId === b.batchId
    const recs = records.get(b.batchId)
    return (
      <Fragment key={b.batchId}>
        <div className={`chv-batch ${isCur ? 'current' : ''} ${selBatches.has(b.batchId) ? 'checked' : ''}`} onClick={() => setCurrent({ kind: 'batch', batchId: b.batchId })} onDoubleClick={() => toggleExpand(b.batchId)}>
          <button
            className="btn ghost icon small chv-twisty"
            onClick={(e) => {
              e.stopPropagation()
              toggleExpand(b.batchId)
            }}
            title={open ? 'Collapse' : 'Show documents'}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
          <input type="checkbox" checked={selBatches.has(b.batchId)} onClick={(e) => e.stopPropagation()} onChange={() => toggleBatch(b.batchId)} title="Select the whole operation" />
          <div className="chv-batch-main">
            <div className="chv-batch-top">
              {(Object.entries(b.ops) as [ChangeOp, number][]).map(([o, n]) => (
                <OpChip key={o} op={o} n={n} />
              ))}
              <span className="chv-batch-label ellipsis" title={b.label}>
                {b.label ?? SOURCE_LABEL[b.source]}
              </span>
            </div>
            <div className="chv-batch-sub">
              <span className={`chv-src src-${b.source}`}>{SOURCE_LABEL[b.source]}</span>
              {!coll && <span className="mono ellipsis chv-batch-coll">{b.coll}</span>}
              <span className="faint" title={fullTime(b.at)}>
                {relTime(b.at)}
              </span>
            </div>
          </div>
          <span className="chv-count" title={`${plural(b.count, 'document')}${filtered ? ' matching the filters' : ''} · ${bytes(b.bytes)}`}>
            {num(b.count)}
          </span>
        </div>
        {open && (
          <div className="chv-records">
            {!recs && <div className="faint chv-rec-msg">Loading…</div>}
            {recs?.length === 0 && <div className="faint chv-rec-msg">No documents</div>}
            {recs?.map((r) => (
              <div
                key={r.id}
                className={`chv-rec ${current?.kind === 'record' && current.id === r.id ? 'current' : ''} ${selRecords.has(r.id) ? 'checked' : ''}`}
                onClick={() => setCurrent({ kind: 'record', id: r.id, batchId: b.batchId })}
              >
                <input type="checkbox" checked={selRecords.has(r.id) || selBatches.has(b.batchId)} disabled={selBatches.has(b.batchId)} onClick={(e) => e.stopPropagation()} onChange={() => toggleRecord(r.id)} />
                <span className={`chv-dot op-${r.op}`} title={OP_LABEL[r.op]} />
                <span className="mono ellipsis chv-rec-id">{r.op === 'drop' ? (r.label ?? 'Collection dropped') : idText(r.docId)}</span>
                <span className="faint chv-rec-size">{bytes(r.size)}</span>
              </div>
            ))}
            {recs && recs.length >= 5000 && <div className="faint chv-rec-msg">Showing the first 5,000 documents; restoring the operation includes all of them.</div>}
          </div>
        )}
      </Fragment>
    )
  }

  const recordDetail = (d: ChangeRecordDetail): ReactElement => {
    const r = d.record
    const beforeMarks = pick(d.changed, ['removed', 'changed'])
    const afterMarks = pick(d.changed, ['added', 'changed'])
    const currentMarks = d.since.map((x) => ({ path: x.path, mark: 'since' as Mark }))
    const currentHint = d.currentError ? 'could not be read' : d.current === null ? 'missing' : d.since.length ? `${plural(d.since.length, 'field')} changed since` : r.hasAfter ? 'unchanged since' : undefined
    return (
      <div className="chv-detail">
        <div className="chv-detail-head">
          <OpChip op={r.op} />
          <span className="mono ellipsis selectable chv-detail-id" title={shellText(r.docId)}>
            {r.op === 'drop' ? (r.label ?? 'Collection dropped') : shellText(r.docId)}
          </span>
          <span className="spacer" />
          <span className="faint" title={fullTime(r.at)}>
            {SOURCE_LABEL[r.source]} · {fullTime(r.at)}
          </span>
        </div>
        <div className="chv-detail-bar">
          <button className="btn primary small" disabled={busy || r.op === 'drop'} onClick={() => void restore({ ids: [r.id] }, `this ${OP_LABEL[r.op].toLowerCase()}`)}>
            <Icon name="history" size={13} /> Restore
          </button>
          <button className="btn small" disabled={!d.before} onClick={() => void copyJson(d.before, 'Before image')}>
            <Icon name="copy" size={13} /> Copy before
          </button>
          <button className="btn small" disabled={!d.after} onClick={() => void copyJson(d.after, 'After image')}>
            <Icon name="copy" size={13} /> Copy after
          </button>
          <span className="spacer" />
          {d.changed.length > 0 && <span className="chv-legend">{plural(d.changed.length, 'field')} changed</span>}
          <button className="btn ghost icon small" title="Purge this change" onClick={() => void purge({ kind: 'ids', ids: [r.id] }, <>Remove this change of {idText(r.docId)} from the history?</>)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
        {d.conflict && (
          <div className="notice chv-conflict">
            <Icon name="warn" size={13} /> {d.conflict}. Restoring overwrites the newer edits highlighted in <b>Current</b>.
          </div>
        )}
        {d.currentError && <div className="notice error chv-conflict">Current document: {d.currentError}</div>}
        {r.op === 'drop' ? (
          <div className="chv-empty">
            <Icon name="warn" size={22} />
            <div>{r.label}</div>
            <div className="faint">Dropping a collection before an import is noted here, but its documents were not captured.</div>
          </div>
        ) : (
          <div className="chv-panes">
            <DocPane title="Before" hint={r.op === 'insert' ? undefined : 'restored by Restore'} tone="before" doc={d.before} marks={beforeMarks} empty="None — the document was inserted by this change" />
            <DocPane title="Current" hint={currentHint} tone="current" doc={d.current} marks={currentMarks} empty={d.currentError ? 'Could not read the document' : 'The document does not exist now'} />
            <DocPane title="After" hint={r.op === 'delete' ? undefined : 'right after the change'} tone="after" doc={d.after} marks={afterMarks} empty={r.op === 'delete' ? 'None — the document was deleted' : 'Not captured (large multi-document write)'} />
          </div>
        )}
      </div>
    )
  }

  const batchDetail = (b: ChangeBatchInfo): ReactElement => (
    <div className="chv-detail">
      <div className="chv-summary">
        <div className="chv-summary-ops">
          {(Object.entries(b.ops) as [ChangeOp, number][]).map(([o, n]) => (
            <OpChip key={o} op={o} n={n} />
          ))}
        </div>
        <h3 className="ellipsis" title={b.label}>
          {b.label ?? SOURCE_LABEL[b.source]}
        </h3>
        <dl>
          <dt>Collection</dt>
          <dd className="mono">
            {b.db}.{b.coll}
          </dd>
          <dt>Source</dt>
          <dd>{SOURCE_LABEL[b.source]}</dd>
          <dt>When</dt>
          <dd>
            {fullTime(b.at)}
            {b.last.getTime() - b.at.getTime() > 1000 && <span className="faint"> → {fullTime(b.last)}</span>}
          </dd>
          <dt>Documents</dt>
          <dd>
            {num(b.count)}
            {filtered && <span className="faint"> matching the filters</span>} · {bytes(b.bytes)}
          </dd>
          <dt>Connection</dt>
          <dd>{b.connName}</dd>
        </dl>
        <div className="chv-summary-actions">
          <button className="btn primary" disabled={busy || (Object.keys(b.ops).length === 1 && !!b.ops.drop)} onClick={() => void restore({ batchIds: [b.batchId] }, 'this whole operation')}>
            <Icon name="history" size={14} /> Restore operation
          </button>
          <button className="btn" onClick={() => toggleExpand(b.batchId)}>
            <Icon name="table" size={14} /> {expanded.has(b.batchId) ? 'Hide documents' : 'Show documents'}
          </button>
          <span className="spacer" />
          <button className="btn danger" onClick={() => void purge({ kind: 'batches', batchIds: [b.batchId] }, <>Remove this operation ({plural(b.count, 'document')}) from the history?</>)}>
            <Icon name="trash" size={14} /> Purge
          </button>
        </div>
        {filtered && <div className="faint chv-summary-note">Restore operation includes every document of the operation, not only those matching the filters.</div>}
      </div>
    </div>
  )

  // The connection's own Change History setting wins over the preference.
  const override = useStore((s) => {
    const l = s.live[tab.connId]
    return l ? s.connections.find((c) => c.id === l.configId)?.overrides?.changeHistory : undefined
  })
  const disabled = settings && !(override ?? settings.enabled)

  return (
    <div className="chv">
      <div className="chv-head">
        <Icon name="history" size={16} />
        <span className="chv-title">Change History</span>
        <span className="chv-crumb mono ellipsis">{scopeName === `every collection of ${tab.db}` ? tab.db : `${tab.db}.${coll}`}</span>
        <span className="spacer" />
        {selCount > 0 && (
          <>
            <span className="chv-selcount">{num(selCount)} selected</span>
            <button className="btn small primary" disabled={busy} onClick={() => void restore(selection, 'the selected changes')}>
              <Icon name="history" size={13} /> Restore selected
            </button>
            <button className="btn ghost small" onClick={clearSelection}>
              Clear
            </button>
          </>
        )}
        <button className="btn small" onClick={purgeMenu}>
          <Icon name="trash" size={13} /> Purge
        </button>
        <button className="btn ghost icon small" title="Refresh" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
        <div className="chv-gear" ref={gearRef}>
          <button className={`btn ghost icon small ${gear ? 'active' : ''}`} title="Change History settings" onClick={() => setGear((g) => !g)}>
            <Icon name="settings" size={14} />
          </button>
          {gear && (
            <div className="chv-pop">
              <div className="chv-pop-head">Change History settings</div>
              <ChangeHistorySettings compact onChanged={setSettings} />
            </div>
          )}
        </div>
      </div>

      <div className="chv-filters">
        <select className="input small" value={coll} onChange={(e) => setColl(e.target.value)} title="Collection">
          <option value="">All collections</option>
          {[...new Set([...colls, ...(tab.coll ? [tab.coll] : []), ...(coll ? [coll] : [])])].sort().map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="input small" value={op} onChange={(e) => setOp(e.target.value as ChangeOp | '')} title="Operation">
          <option value="">Any operation</option>
          {CHANGE_OPS.map((o) => (
            <option key={o} value={o}>
              {OP_LABEL[o]}
            </option>
          ))}
        </select>
        <select className="input small" value={source} onChange={(e) => setSource(e.target.value as ChangeSource | '')} title="Source">
          <option value="">Any source</option>
          {CHANGE_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="chv-date">
          <span className="faint">From</span>
          <input className="input small" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="chv-date">
          <span className="faint">To</span>
          <input className="input small" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="chv-search">
          <Icon name="search" size={13} />
          <input className="input small" placeholder="Search _id…" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {filtered && (
          <button
            className="btn ghost small"
            onClick={() => {
              setOp('')
              setSource('')
              setFrom('')
              setTo('')
              setText('')
            }}
          >
            <Icon name="close" size={12} /> Clear filters
          </button>
        )}
      </div>

      {disabled && (
        <div className="notice chv-off">
          <Icon name="warn" size={13} /> Change History is turned off{override === false ? ' for this connection (connection settings → Behavior)' : ''}: new edits are not recorded.{' '}
          <button className="link" onClick={() => setGear(true)}>
            Settings
          </button>
        </div>
      )}

      <div className="chv-body">
        <div className="chv-list">
          {error && <div className="notice error chv-list-msg">{error}</div>}
          {loading && <div className="loading-bar" />}
          {batches && batches.length === 0 && !error && (
            <div className="chv-empty">
              <Icon name="history" size={26} />
              <div>{filtered ? 'No changes match the filters' : 'No changes recorded yet'}</div>
              <div className="faint">Documents edited, deleted, synced, masked or imported through Shardwise appear here and can be restored.</div>
            </div>
          )}
          {batches?.map(batchRow)}
          {batches && batches.length >= limit && (
            <button className="btn ghost small chv-more" onClick={() => setLimit((l) => l + PAGE)}>
              Load more
            </button>
          )}
        </div>
        <div className="chv-side">
          {current?.kind === 'record' && detail && detail.record.id === current.id && recordDetail(detail)}
          {current?.kind === 'record' && detailError && <div className="notice error chv-list-msg">{detailError}</div>}
          {current?.kind === 'batch' && currentBatch && batchDetail(currentBatch)}
          {(!current || (current.kind === 'batch' && !currentBatch)) && (
            <div className="chv-empty">
              <Icon name="compare" size={26} />
              <div>Select an operation or a document</div>
              <div className="faint">Expand an operation to compare each document before, now and after the change.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
