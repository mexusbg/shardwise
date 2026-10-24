import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { EJSON } from 'bson'
import { bsonTypeOf, cellText, shellText, TYPE_LABELS } from '@shared/bsonValue'
import type { ConvertTarget, PreviewPair, ReschemaDryRun, ReschemaOp, ReschemaRequest } from '@shared/maskingApi'
import { compileOps, CONVERT_LABELS, OP_LABELS, reschemaCommand, reschemaProblem } from '@shared/reschema'
import { api } from '../../lib/api'
import { connName, errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { showMenu } from '../ContextMenu'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { FilterBox, fmt, JobStrip, PairsPreview, parseConstant, parsedFilter, plural, useDebounced, useJob, useSampledFields } from './common'
import { maskingApi } from './maskingClient'
import './masking.css'

type Kind = ReschemaOp['kind']

interface Item {
  id: number
  op: ReschemaOp
  /** default: the value as typed; merge: the field list as typed. */
  text?: string
}

const KINDS = Object.keys(OP_LABELS) as Kind[]
const TARGETS = Object.keys(CONVERT_LABELS) as ConvertTarget[]
const OP_ICONS: Record<Kind, string> = {
  rename: 'edit',
  remove: 'trash',
  default: 'plus',
  convert: 'refresh',
  split: 'stepIn',
  merge: 'stepOut',
  flatten: 'table',
  nest: 'tree',
  extract: 'filter'
}
const BIG_COLLECTION = 100_000

function newOp(kind: Kind): ReschemaOp {
  switch (kind) {
    case 'rename':
      return { kind, from: '', to: '' }
    case 'remove':
      return { kind, path: '' }
    case 'default':
      return { kind, path: '', value: undefined }
    case 'convert':
      return { kind, path: '', to: 'int', onError: 'keep' }
    case 'split':
      return { kind, path: '', separator: ',', trim: true, dropEmpty: true }
    case 'merge':
      return { kind, paths: [], separator: ' ', to: '', removeSources: false }
    case 'flatten':
      return { kind, path: '', prefix: '' }
    case 'nest':
      return { kind, prefix: '', to: '', parent: '' }
    case 'extract':
      return { kind, path: '', index: 0, to: '', removeSource: false }
  }
}

/** One-line description of an operation for the confirmation dialog and collapsed cards. */
function describe(op: ReschemaOp): string {
  switch (op.kind) {
    case 'rename':
      return `${op.from || '?'} → ${op.to || '?'}`
    case 'remove':
      return op.path || '?'
    case 'default':
      return `${op.path || '?'} = ${op.value === undefined ? '?' : shellText(op.value)}${op.orNull ? ' (also null)' : ''}`
    case 'convert':
      return `${op.path || '?'} → ${CONVERT_LABELS[op.to]}`
    case 'split':
      return `${op.path || '?'} by "${op.separator}"${op.to ? ` → ${op.to}` : ''}`
    case 'merge':
      return `${op.paths.join(' + ') || '?'} → ${op.to || '?'}`
    case 'flatten':
      return `${op.path || '?'} → ${op.prefix || '?'}*`
    case 'nest':
      return `${op.prefix || '?'}* → ${op.parent ? `${op.parent}.` : ''}${op.to || '?'}`
    case 'extract':
      return `${op.path || '?'}[${op.index}]${op.to ? ` → ${op.to}` : ''}`
  }
}

function PathInput({ value, onChange, list, placeholder, width }: { value: string; onChange: (v: string) => void; list: string; placeholder?: string; width?: number }): ReactElement {
  return (
    <input
      className="input small mono rs-path"
      list={list}
      value={value}
      placeholder={placeholder ?? 'field.path'}
      spellCheck={false}
      style={width ? { width, flex: 'none' } : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

const Lbl = ({ children }: { children: ReactNode }): ReactElement => <span className="rs-lbl">{children}</span>

function OpEditor({ item, list, patch, setText }: { item: Item; list: string; patch: (p: Partial<ReschemaOp>) => void; setText: (t: string, p: Partial<ReschemaOp>) => void }): ReactElement {
  const op = item.op
  const last = (p: string): string => p.split('.').pop() ?? p
  switch (op.kind) {
    case 'rename':
      return (
        <div className="rs-fields">
          <PathInput value={op.from} onChange={(v) => patch({ from: v })} list={list} placeholder="old.path" />
          <Icon name="chevronRight" size={13} className="faint" />
          <PathInput value={op.to} onChange={(v) => patch({ to: v })} list={list} placeholder="new.path" />
        </div>
      )
    case 'remove':
      return (
        <div className="rs-fields">
          <PathInput value={op.path} onChange={(v) => patch({ path: v })} list={list} />
        </div>
      )
    case 'default': {
      const t = op.value === undefined ? null : bsonTypeOf(op.value)
      return (
        <div className="rs-fields wrap">
          <PathInput value={op.path} onChange={(v) => patch({ path: v })} list={list} />
          <Lbl>=</Lbl>
          <input
            className="input small mono grow"
            value={item.text ?? ''}
            placeholder="'unknown', 0, false, ISODate(…)"
            onChange={(e) => setText(e.target.value, { value: e.target.value.trim() ? parseConstant(e.target.value) : undefined })}
          />
          {t && <span className="type-tag">{TYPE_LABELS[t]}</span>}
          <label className="check rs-small">
            <input type="checkbox" checked={!!op.orNull} onChange={(e) => patch({ orNull: e.target.checked })} /> also when null
          </label>
        </div>
      )
    }
    case 'convert':
      return (
        <div className="rs-fields wrap">
          <PathInput value={op.path} onChange={(v) => patch({ path: v })} list={list} />
          <Lbl>to</Lbl>
          <select className="select small" value={op.to} onChange={(e) => patch({ to: e.target.value as ConvertTarget })}>
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {CONVERT_LABELS[t]}
              </option>
            ))}
          </select>
          {op.to === 'date' && (
            <input className="input small mono" style={{ width: 130 }} value={op.format ?? ''} placeholder="ISO, or DD/MM/YYYY" onChange={(e) => patch({ format: e.target.value || undefined })} title="Format of string dates: DD MM YYYY HH mm ss SSS tokens, or %d/%m/%Y" />
          )}
          {op.to !== 'array' && op.to !== 'first' && (
            <>
              <Lbl>on failure</Lbl>
              <div className="segmented small">
                <button className={op.onError === 'keep' ? 'on' : ''} onClick={() => patch({ onError: 'keep' })} title="Leave values that cannot be converted unchanged">
                  Keep
                </button>
                <button className={op.onError === 'null' ? 'on' : ''} onClick={() => patch({ onError: 'null' })} title="Set values that cannot be converted to null">
                  Null
                </button>
              </div>
            </>
          )}
        </div>
      )
    case 'split':
      return (
        <div className="rs-fields wrap">
          <PathInput value={op.path} onChange={(v) => patch({ path: v })} list={list} />
          <Lbl>by</Lbl>
          <input className="input small mono" style={{ width: 54 }} value={op.separator} onChange={(e) => patch({ separator: e.target.value })} title="Separator" />
          <label className="check rs-small">
            <input type="checkbox" checked={!!op.trim} onChange={(e) => patch({ trim: e.target.checked })} /> trim
          </label>
          <label className="check rs-small">
            <input type="checkbox" checked={!!op.dropEmpty} onChange={(e) => patch({ dropEmpty: e.target.checked })} /> drop empty
          </label>
          <Lbl>into</Lbl>
          <PathInput value={op.to ?? ''} onChange={(v) => patch({ to: v || undefined })} list={list} placeholder="(same field)" width={130} />
        </div>
      )
    case 'merge':
      return (
        <div className="rs-fields wrap">
          <input
            className="input small mono grow"
            value={item.text ?? op.paths.join(', ')}
            placeholder="firstName, lastName"
            spellCheck={false}
            onChange={(e) => setText(e.target.value, { paths: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
          <Lbl>with</Lbl>
          <input className="input small mono" style={{ width: 54 }} value={op.separator} onChange={(e) => patch({ separator: e.target.value })} title="Separator" />
          <Lbl>into</Lbl>
          <PathInput value={op.to} onChange={(v) => patch({ to: v })} list={list} placeholder="fullName" width={130} />
          <label className="check rs-small">
            <input type="checkbox" checked={!!op.removeSources} onChange={(e) => patch({ removeSources: e.target.checked })} /> remove sources
          </label>
        </div>
      )
    case 'flatten':
      return (
        <div className="rs-fields">
          <PathInput
            value={op.path}
            onChange={(v) => patch({ path: v, prefix: !op.prefix || op.prefix === `${last(op.path)}_` ? (v ? `${last(v)}_` : '') : op.prefix })}
            list={list}
            placeholder="address"
          />
          <Lbl>prefix</Lbl>
          <input className="input small mono" style={{ width: 120 }} value={op.prefix} onChange={(e) => patch({ prefix: e.target.value })} placeholder="address_" />
        </div>
      )
    case 'nest':
      return (
        <div className="rs-fields wrap">
          <input
            className="input small mono"
            style={{ width: 110 }}
            value={op.prefix}
            placeholder="address_"
            spellCheck={false}
            onChange={(e) => patch({ prefix: e.target.value, to: !op.to || op.to === op.prefix.replace(/[_\-.]+$/, '') ? e.target.value.replace(/[_\-.]+$/, '') : op.to })}
          />
          <Lbl>* into</Lbl>
          <input className="input small mono" style={{ width: 110 }} value={op.to} placeholder="address" onChange={(e) => patch({ to: e.target.value })} />
          <Lbl>inside</Lbl>
          <PathInput value={op.parent ?? ''} onChange={(v) => patch({ parent: v })} list={list} placeholder="(top level)" width={120} />
        </div>
      )
    case 'extract':
      return (
        <div className="rs-fields wrap">
          <PathInput value={op.path} onChange={(v) => patch({ path: v })} list={list} placeholder="tags" />
          <Lbl>index</Lbl>
          <input
            className="input small mono"
            type="number"
            style={{ width: 60 }}
            value={op.index}
            onChange={(e) => patch({ index: Math.trunc(Number(e.target.value) || 0) })}
            title="0 = first, -1 = last"
          />
          <Lbl>into</Lbl>
          <PathInput value={op.to ?? ''} onChange={(v) => patch({ to: v || undefined })} list={list} placeholder="(replace array)" width={130} />
          {!!op.to && (
            <label className="check rs-small">
              <input type="checkbox" checked={!!op.removeSource} onChange={(e) => patch({ removeSource: e.target.checked })} /> remove array
            </label>
          )}
        </div>
      )
  }
}

function Stat({ label, value, kind }: { label: string; value: string; kind?: string }): ReactElement {
  return (
    <div className={`rs-stat ${kind ?? ''}`}>
      <span className="rs-stat-value">{value}</span>
      <span className="rs-stat-label">{label}</span>
    </div>
  )
}

type Pane = 'preview' | 'command' | 'dryrun'

/** Rename / move / retype fields across a collection with an update pipeline, a preview and a dry run. */
export function ReschemaView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const coll = tab.coll ?? ''
  const connected = useStore((s) => !!s.live[connId])
  const sampled = useSampledFields(connId, db, coll, connected)
  const fieldNames = useMemo(() => sampled.fields.map((f) => f.path), [sampled.fields])
  const listId = `rs-fields-${tab.id}`
  const nextId = useRef(1)
  const [items, setItems] = useState<Item[]>([])
  const [filterText, setFilterText] = useState('')
  const [upTo, setUpTo] = useState<number | null>(null)
  const [pane, setPane] = useState<Pane>('preview')
  const [pairs, setPairs] = useState<PreviewPair[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dry, setDry] = useState<{ key: string; result: ReschemaDryRun } | null>(null)
  const [dryBusy, setDryBusy] = useState(false)
  const [dryError, setDryError] = useState<string | null>(null)
  const [batched, setBatched] = useState(false)
  const [batchSize, setBatchSize] = useState(1000)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId)
  const running = job?.state === 'running'

  useEffect(() => {
    if (!connected) return
    api
      .estimatedCount(connId, db, coll)
      .then((n) => n >= BIG_COLLECTION && setBatched(true))
      .catch(() => {})
  }, [connId, db, coll, connected])

  const ops = useMemo(() => items.map((i) => i.op), [items])
  const filter = parsedFilter(filterText)
  const problem = useMemo(() => (ops.length ? reschemaProblem(ops) : null), [ops])
  const previewOps = useMemo(() => (upTo === null ? ops : ops.slice(0, upTo + 1)), [ops, upTo])
  const previewProblem = useMemo(() => (previewOps.length ? reschemaProblem(previewOps) : null), [previewOps])
  const request = (o: ReschemaOp[]): ReschemaRequest => ({ connId, db, coll, filter: filter ?? {}, ops: o })
  const key = useMemo(() => EJSON.stringify({ f: filter ?? null, ops } as never, { relaxed: false }), [filter, ops])
  const previewKey = useDebounced(EJSON.stringify({ f: filter ?? null, ops: previewOps } as never, { relaxed: false }), 350)
  const freshDry = dry && dry.key === key ? dry.result : null

  const command = useMemo(() => {
    if (!ops.length || problem) return null
    try {
      return reschemaCommand(coll, filter ?? {}, compileOps(ops))
    } catch {
      return null
    }
  }, [ops, problem, coll, filter])

  const seq = useRef(0)
  const refresh = async (): Promise<void> => {
    if (!connected || filter === undefined) return
    const n = ++seq.current
    if (!previewOps.length) {
      setLoading(true)
      try {
        const r = await maskingApi.maskingPreview({ connId, db, coll, filter }, [], '', 20)
        if (n === seq.current) {
          setPairs(r)
          setError(null)
        }
      } catch (e) {
        if (n === seq.current) setError(errorText(e))
      } finally {
        if (n === seq.current) setLoading(false)
      }
      return
    }
    if (previewProblem) return
    setLoading(true)
    try {
      const r = await maskingApi.reschemaPreview(request(previewOps), 20)
      if (n !== seq.current) return
      setPairs(r)
      setError(null)
    } catch (e) {
      if (n === seq.current) setError(errorText(e))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, connected])

  useEffect(() => {
    if (job && job.state !== 'running') {
      setDry(null)
      setPane('preview')
      sampled.reload()
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.state])

  const add = (kind: Kind): void => {
    const id = nextId.current++
    setItems((xs) => [...xs, { id, op: newOp(kind) }])
    setUpTo(null)
  }
  const patch = (id: number, p: Partial<ReschemaOp>): void => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, op: { ...x.op, ...p } as ReschemaOp } : x)))
  const setText = (id: number, text: string, p: Partial<ReschemaOp>): void => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, text, op: { ...x.op, ...p } as ReschemaOp } : x)))
  const move = (i: number, d: -1 | 1): void =>
    setItems((xs) => {
      const j = i + d
      if (j < 0 || j >= xs.length) return xs
      const copy = [...xs]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
  const remove = (i: number): void => {
    setItems((xs) => xs.filter((_, k) => k !== i))
    setUpTo((u) => (u === null ? null : u >= i ? (u === i ? null : u - 1) : u))
  }

  const runDry = async (): Promise<ReschemaDryRun | null> => {
    if (problem || filter === undefined || !ops.length) return null
    setDryBusy(true)
    setDryError(null)
    setPane('dryrun')
    try {
      const result = await maskingApi.reschemaDryRun(request(ops))
      setDry({ key, result })
      return result
    } catch (e) {
      setDryError(errorText(e))
      return null
    } finally {
      setDryBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (problem) return toast(problem.message, 'error')
    if (filter === undefined) return toast('The filter is not valid', 'error')
    const d = freshDry ?? (await runDry())
    if (!d) return
    if (!d.changed) return toast('Nothing to change: no document would be modified')
    const failing = d.failures.filter((f) => f.count > 0)
    const ok = await confirmDialog({
      title: 'Apply reschema',
      danger: true,
      confirmLabel: `Update ${fmt(d.changed)} document${d.changed === 1 ? '' : 's'}`,
      message: (
        <div className="rs-confirm">
          <p>
            <b>{fmt(d.changed)}</b> of {plural(d.matched, 'matching document')} in <span className="mono">{db}.{coll}</span> will be rewritten by {plural(ops.length, 'operation')}:
          </p>
          <ol>
            {ops.map((o, i) => (
              <li key={i}>
                <span className="muted">{OP_LABELS[o.kind]}</span> <span className="mono">{describe(o)}</span>
              </li>
            ))}
          </ol>
          {failing.map((f) => {
            const op = ops[f.op]
            return (
              <p key={f.op} className="rs-confirm-warn">
                <Icon name="warn" size={13} /> {plural(f.count, 'value')} of <span className="mono">{f.path}</span> cannot become {CONVERT_LABELS[f.to]}: they will be{' '}
                {op.kind === 'convert' && op.onError === 'null' ? 'set to null' : 'left unchanged'}.
              </p>
            )
          })}
          <p className="muted">{batched ? `Runs in batches of ${fmt(batchSize)} documents with progress; cancelling keeps the batches already written.` : 'Runs as a single updateMany.'} There is no undo.</p>
        </div>
      )
    })
    if (!ok) return
    try {
      setJobId(await maskingApi.reschemaStart(request(ops), { batchSize: batched ? Math.max(1, batchSize) : 0 }))
    } catch (e) {
      toast(`Could not start: ${errorText(e)}`, 'error')
    }
  }

  // Changing what failing values become changes the counts: dry-run again once the operation is updated.
  const [redo, setRedo] = useState(false)
  const setOnError = (opIndex: number, onError: 'keep' | 'null'): void => {
    const it = items[opIndex]
    if (!it) return
    patch(it.id, { onError } as Partial<ReschemaOp>)
    setRedo(true)
  }
  useEffect(() => {
    if (!redo) return
    setRedo(false)
    void runDry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!connected)
    return (
      <div className="mk">
        <div className="mk-empty">
          <Icon name="unplug" size={34} />
          <h3>Disconnected</h3>
          <p className="muted">Reconnect to reschema {coll}.</p>
        </div>
      </div>
    )

  const changedPaths = previewOps.flatMap((o) =>
    o.kind === 'rename' ? [o.from, o.to] : o.kind === 'merge' ? [o.to, ...o.paths] : o.kind === 'nest' ? [o.parent ? `${o.parent}.${o.to}` : o.to] : 'path' in o ? [o.path, ...('to' in o && o.to ? [o.to] : [])] : []
  )

  return (
    <div className="mk">
      <div className="mk-head">
        <Icon name="reschema" size={16} className="mk-head-icon" />
        <span className="mk-title ellipsis" title={`${connName(connId)} · ${db}.${coll}`}>
          Restructure Fields <span className="faint">{db}.</span>
          {coll}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={() => void runDry()} disabled={!ops.length || !!problem || filter === undefined || dryBusy} title="Count the documents that would change and the conversions that would fail">
          <Icon name="count" size={13} /> Dry run
        </button>
        <button className="btn small primary" onClick={() => void apply()} disabled={!ops.length || !!problem || filter === undefined || running || dryBusy} title={problem?.message ?? 'Run the update on the collection'}>
          <Icon name="play" size={13} /> Apply…
        </button>
      </div>

      <div className="mk-body">
        <section className="mk-left">
          <div className="mk-setup">
            <div className="mk-setup-row">
              <label className="mk-label">Filter</label>
              <FilterBox value={filterText} onChange={setFilterText} fields={fieldNames} onSubmit={() => void refresh()} />
            </div>
          </div>

          <div className="mk-rules-bar">
            <span className="mk-section-title">Operations</span>
            <span className="faint mk-small">applied in order</span>
            <span className="spacer" />
            <button
              className="btn small"
              onClick={(e) =>
                showMenu(
                  e,
                  KINDS.map((k) => ({ label: OP_LABELS[k], icon: OP_ICONS[k], onClick: () => add(k) }))
                )
              }
            >
              <Icon name="plus" size={13} /> Add operation
            </button>
          </div>

          <div className="rs-ops">
            {!items.length && (
              <div className="rs-intro">
                <Icon name="reschema" size={30} />
                <p>Add operations to rename, move, retype, split, merge, flatten or nest fields. They compile to an update pipeline the server runs; preview and dry-run before applying.</p>
                <div className="rs-quick">
                  {(['rename', 'convert', 'remove', 'flatten'] as Kind[]).map((k) => (
                    <button key={k} className="btn small" onClick={() => add(k)}>
                      <Icon name={OP_ICONS[k]} size={12} /> {OP_LABELS[k]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {items.map((it, i) => {
              const err = problem && problem.op === i ? problem.message : null
              const inPreview = upTo === null || i <= upTo
              return (
                <div key={it.id} className={`rs-op ${err ? 'error' : ''} ${inPreview ? '' : 'dim'} ${upTo === i ? 'upto' : ''}`}>
                  <div className="rs-op-head">
                    <span className="rs-op-num">{i + 1}</span>
                    <Icon name={OP_ICONS[it.op.kind]} size={13} className="rs-op-icon" />
                    <span className="rs-op-title">{OP_LABELS[it.op.kind]}</span>
                    <span className="spacer" />
                    <button
                      className={`btn small ghost icon ${upTo === i ? 'active' : ''}`}
                      onClick={() => {
                        setUpTo(upTo === i ? null : i)
                        setPane('preview')
                      }}
                      title={upTo === i ? 'Preview all operations' : 'Preview up to this operation'}
                    >
                      <Icon name="stepIn" size={12} />
                    </button>
                    <button className="btn small ghost icon" onClick={() => move(i, -1)} disabled={i === 0} title="Move up">
                      <Icon name="chevronDown" size={12} style={{ transform: 'rotate(180deg)' }} />
                    </button>
                    <button className="btn small ghost icon" onClick={() => move(i, 1)} disabled={i === items.length - 1} title="Move down">
                      <Icon name="chevronDown" size={12} />
                    </button>
                    <button className="btn small ghost icon" onClick={() => remove(i)} title="Remove">
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                  <OpEditor item={it} list={listId} patch={(p) => patch(it.id, p)} setText={(t, p) => setText(it.id, t, p)} />
                  {err && <div className="rs-op-err">{err.replace(/^[^:]+: /, '')}</div>}
                </div>
              )
            })}
            <datalist id={listId}>
              {fieldNames.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>

          <div className="rs-apply-bar">
            <span className="mk-small muted">Apply as</span>
            <div className="segmented small">
              <button className={!batched ? 'on' : ''} onClick={() => setBatched(false)} title="One updateMany: fastest, no progress">
                One updateMany
              </button>
              <button className={batched ? 'on' : ''} onClick={() => setBatched(true)} title="updateMany per batch of _ids, with progress and cancel">
                Batches
              </button>
            </div>
            {batched && (
              <>
                <span className="mk-small faint">of</span>
                <input className="input small mono" type="number" min={1} style={{ width: 80 }} value={batchSize} onChange={(e) => setBatchSize(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
              </>
            )}
          </div>
        </section>

        <section className="mk-right">
          <div className="rs-tabs">
            {(
              [
                ['preview', 'Preview', 'compare'],
                ['dryrun', 'Dry run', 'count'],
                ['command', 'Command', 'code']
              ] as [Pane, string, string][]
            ).map(([p, label, icon]) => (
              <button key={p} className={`rs-tab ${pane === p ? 'on' : ''}`} onClick={() => setPane(p)}>
                <Icon name={icon} size={13} /> {label}
                {p === 'dryrun' && freshDry && <span className="mk-count">{fmt(freshDry.changed)}</span>}
              </button>
            ))}
            <span className="spacer" />
            {upTo !== null && pane === 'preview' && (
              <button className="btn small ghost" onClick={() => setUpTo(null)} title="Preview all operations">
                Through #{upTo + 1} <Icon name="close" size={11} />
              </button>
            )}
          </div>

          {pane === 'preview' && (
            <PairsPreview
              pairs={pairs}
              loading={loading}
              error={filter === undefined ? 'The filter is not valid shell syntax' : previewProblem ? `Operation ${previewProblem.op + 1}: ${previewProblem.message}` : error}
              focus={changedPaths}
              title={previewOps.length ? (upTo === null ? 'All operations' : `Operations 1–${upTo + 1}`) : 'Documents'}
              empty="Loading the first documents…"
              actions={
                <button className="btn small ghost icon" onClick={() => void refresh()} title="Refresh the preview">
                  <Icon name="refresh" size={13} />
                </button>
              }
            />
          )}

          {pane === 'command' && (
            <div className="rs-command">
              <div className="mk-preview-bar">
                <span className="mk-section-title">Update command</span>
                <span className="faint mk-small">mongosh</span>
                <span className="spacer" />
                <button className="btn small" disabled={!command} onClick={() => command && void api.copyText(command).then(() => toast('Command copied', 'success'))}>
                  <Icon name="copy" size={12} /> Copy
                </button>
              </div>
              {command ? (
                <div className="rs-command-code">
                  <CodeEditor value={command} readOnly full />
                </div>
              ) : (
                <div className="mk-preview-empty">{problem ? `Operation ${problem.op + 1}: ${problem.message}` : 'Add operations to see the generated updateMany.'}</div>
              )}
            </div>
          )}

          {pane === 'dryrun' && (
            <div className="rs-dry">
              {dryBusy && (
                <div className="mk-preview-empty">
                  <span className="mk-spinner" /> Counting…
                </div>
              )}
              {!dryBusy && dryError && <div className="notice error mk-preview-msg">{dryError}</div>}
              {!dryBusy && !dryError && !freshDry && (
                <div className="mk-preview-empty">
                  <div className="col" style={{ alignItems: 'center' }}>
                    <span>{dry ? 'The operations or the filter changed since the last dry run.' : 'Count what an update would do, without writing anything.'}</span>
                    <button className="btn small primary" onClick={() => void runDry()} disabled={!ops.length || !!problem || filter === undefined}>
                      <Icon name="count" size={13} /> Run dry run
                    </button>
                  </div>
                </div>
              )}
              {!dryBusy && freshDry && (
                <div className="rs-dry-body">
                  <div className="rs-stats">
                    <Stat label="Matching documents" value={fmt(freshDry.matched)} />
                    <Stat label="Would change" value={fmt(freshDry.changed)} kind="changed" />
                    <Stat label="Unchanged" value={fmt(freshDry.matched - freshDry.changed)} kind="same" />
                    <Stat label="Failed conversions" value={fmt(freshDry.failures.reduce((n, f) => n + f.count, 0))} kind={freshDry.failures.some((f) => f.count) ? 'failed' : 'same'} />
                  </div>
                  <div className="faint mk-small">Computed in {freshDry.ms < 1000 ? `${freshDry.ms} ms` : `${(freshDry.ms / 1000).toFixed(1)} s`}, with earlier operations applied first.</div>
                  {freshDry.failures.length > 0 && (
                    <div className="rs-failures">
                      <div className="mk-section-title">Type conversions</div>
                      {freshDry.failures.map((f) => {
                        const op = ops[f.op]
                        return (
                          <div key={f.op} className={`rs-failure ${f.count ? 'bad' : 'ok'}`}>
                            <div className="rs-failure-head">
                              <Icon name={f.count ? 'warn' : 'check'} size={14} />
                              <span className="rs-op-num">{f.op + 1}</span>
                              <span className="mono">{f.path}</span>
                              <span className="faint">→ {CONVERT_LABELS[f.to]}</span>
                              <span className="spacer" />
                              <span className="mk-small">{f.count ? `${plural(f.count, 'value')} cannot be converted` : 'all values convert'}</span>
                            </div>
                            {f.count > 0 && op?.kind === 'convert' && (
                              <>
                                <div className="rs-failure-opts">
                                  <span className="mk-small muted">Failing values</span>
                                  <div className="segmented small">
                                    <button className={op.onError === 'keep' ? 'on' : ''} onClick={() => setOnError(f.op, 'keep')}>
                                      Leave unchanged
                                    </button>
                                    <button className={op.onError === 'null' ? 'on' : ''} onClick={() => setOnError(f.op, 'null')}>
                                      Set null
                                    </button>
                                  </div>
                                </div>
                                <div className="rs-ids">
                                  <span className="mk-small faint">First _ids:</span>
                                  {f.sampleIds.map((id, k) => (
                                    <button key={k} className="rs-id mono" title="Copy" onClick={() => void api.copyText(shellText(id)).then(() => toast('Copied', 'success'))}>
                                      {cellText(id)}
                                    </button>
                                  ))}
                                  {f.count > f.sampleIds.length && <span className="faint mk-small">+{fmt(f.count - f.sampleIds.length)} more</span>}
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="row">
                    <button className="btn small" onClick={() => void runDry()}>
                      <Icon name="refresh" size={12} /> Run again
                    </button>
                    <button className="btn small primary" onClick={() => void apply()} disabled={running || !freshDry.changed}>
                      <Icon name="play" size={12} /> Apply…
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      <JobStrip job={job} onCancel={() => jobId && void maskingApi.maskingCancel(jobId)} onDismiss={() => setJobId(null)} />
    </div>
  )
}
