import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { Doc, IndexInfo } from '@shared/api'
import {
  COLLATION_LOCALES,
  COLLATION_STRENGTHS,
  KEY_KINDS,
  TEXT_LANGUAGES,
  buildIndex,
  createIndexShell,
  defaultIndexName,
  emptyIndexForm
} from '@shared/indexForm'
import type { IndexForm, KeyKind, KeyRow } from '@shared/indexForm'
import { getPath } from '@shared/docPaths'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { FieldInput } from './FieldInput'
import './indexes.css'

export interface CreateIndexOptions {
  connId: string
  db: string
  coll: string
  /** Current indexes (for validation); loaded when omitted. */
  existing?: IndexInfo[]
  /** Pre-filled keys, e.g. from an index suggestion. */
  keys?: KeyRow[]
  docCount?: number | null
  /** Called when the build starts / finishes (also after the dialog was sent to the background). */
  onStart?: () => void
  onDone?: (name: string | null) => void
}

const LARGE = 100_000

function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return ''
  if (sec === 0) return 'as soon as the date passes'
  const units: [number, string][] = [
    [86400 * 365, 'year'],
    [86400 * 30, 'month'],
    [86400 * 7, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second']
  ]
  const parts: string[] = []
  let rest = sec
  for (const [s, n] of units) {
    const q = Math.floor(rest / s)
    if (q) {
      parts.push(`${q} ${n}${q === 1 ? '' : 's'}`)
      rest -= q * s
    }
    if (parts.length === 2) break
  }
  return `after ${parts.join(' ')}`
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div className="ixf-section">
      <div className="ixf-section-head">
        <span>{title}</span>
        {hint && <span className="faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function CreateIndexBody({ o, close }: { o: CreateIndexOptions; close: (name: string | null) => void }): ReactElement {
  const { connId, db, coll } = o
  const [form, setForm] = useState<IndexForm>(() => emptyIndexForm(o.keys?.length ? o.keys : undefined))
  const [existing, setExisting] = useState<IndexInfo[]>(o.existing ?? [])
  const [fields, setFields] = useState<string[]>([])
  const [docCount, setDocCount] = useState<number | null>(o.docCount ?? null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [ttlSample, setTtlSample] = useState<string | null>(null)
  const background = useRef(false)

  const patch = (p: Partial<IndexForm>): void => setForm((f) => ({ ...f, ...p }))
  const setRow = (i: number, p: Partial<KeyRow>): void => setForm((f) => ({ ...f, keys: f.keys.map((r, j) => (j === i ? { ...r, ...p } : r)) }))
  const moveRow = (i: number, d: -1 | 1): void =>
    setForm((f) => {
      const keys = [...f.keys]
      const j = i + d
      if (j < 0 || j >= keys.length) return f
      ;[keys[i], keys[j]] = [keys[j], keys[i]]
      return { ...f, keys }
    })
  const onOpenChange = useCallback((v: boolean) => setSuggestOpen(v), [])

  useEffect(() => {
    let alive = true
    api
      .sampleFields(connId, db, coll, 200)
      .then((f) => alive && setFields(f))
      .catch(() => {})
    if (!o.existing)
      api
        .listIndexes(connId, db, coll)
        .then((l) => alive && setExisting(l))
        .catch(() => {})
    if (o.docCount == null)
      api
        .estimatedCount(connId, db, coll)
        .then((n) => alive && setDocCount(n))
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [connId, db, coll, o.existing, o.docCount])

  const built = useMemo(() => buildIndex(form, existing), [form, existing])
  const command = useMemo(() => createIndexShell(coll, built.keys, built.options), [coll, built])
  const hasText = form.keys.some((k) => k.kind === 'text')
  const wildcardAll = form.keys.some((k) => k.kind === 'wildcard' && (!k.field.trim() || k.field.trim() === '$**'))
  const ttlPossible = form.keys.length === 1 && (form.keys[0].kind === '1' || form.keys[0].kind === '-1')
  const ttlField = ttlPossible ? form.keys[0].field.trim() : ''

  // Look at a stored value of the TTL field: TTL only deletes documents whose field is a date.
  useEffect(() => {
    setTtlSample(null)
    if (!form.ttlEnabled || !ttlField) return
    let alive = true
    const t = setTimeout(() => {
      api
        .find(connId, db, coll, { filter: { [ttlField]: { $exists: true } }, projection: { [ttlField]: 1 }, skip: 0, limit: 1 })
        .then((r) => {
          if (!alive || !r.docs.length) return
          const v = getPath(r.docs[0], ttlField)
          const isDate = (x: unknown): boolean => x instanceof Date
          if (isDate(v) || (Array.isArray(v) && v.some(isDate))) return
          const kind = v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? ((v as { _bsontype?: string })._bsontype ?? 'an object') : `a ${typeof v}`
          setTtlSample(`A sampled document stores ${ttlField} as ${kind}, not a date: TTL would never delete it.`)
        })
        .catch(() => {})
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [form.ttlEnabled, ttlField, connId, db, coll])

  const create = async (): Promise<void> => {
    if (built.errors.length || running) return
    setRunning(true)
    setRunError(null)
    o.onStart?.()
    let created: string | null = null
    try {
      created = await api.createIndex(connId, db, coll, built.keys, built.options)
      toast(`Index ${created} created on ${coll}`, 'success')
      if (!background.current) close(created)
    } catch (e) {
      if (background.current) toast(`Could not create the index on ${coll}: ${errorText(e)}`, 'error')
      else setRunError(errorText(e))
    } finally {
      setRunning(false)
      o.onDone?.(created)
    }
  }

  const toBackground = (): void => {
    background.current = true
    close(null)
  }

  const large = docCount != null && docCount >= LARGE
  const placeholderName = defaultIndexName(built.keys) || 'generated from the keys'

  return (
    <Modal
      title={
        <>
          Create index on <span className="mono">{db}.{coll}</span>
        </>
      }
      icon="key"
      width={780}
      escape={!suggestOpen}
      onClose={running ? toBackground : () => close(null)}
      footer={
        running ? (
          <>
            <span className="ixf-building">
              <span className="ixf-spinner" /> Building index… you can keep working; progress shows in the index list.
            </span>
            <span className="spacer" />
            <button className="btn" onClick={toBackground}>
              Continue in background
            </button>
          </>
        ) : (
          <>
            <span className="ixf-foot-note faint">
              {built.errors.length ? `${built.errors.length} problem${built.errors.length === 1 ? '' : 's'} to fix` : 'Ctrl+Enter to create'}
            </span>
            <span className="spacer" />
            <button className="btn" onClick={() => close(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={built.errors.length > 0} onClick={() => void create()}>
              <Icon name="key" size={13} /> Create index
            </button>
          </>
        )
      }
    >
      <div
        className={`ixf ${running ? 'busy' : ''}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void create()
          }
        }}
      >
        <Section title="Keys" hint="Order matters: equality fields first, then sort, then range">
          <div className="ixf-keys">
            {form.keys.map((r, i) => (
              <div key={i} className="ixf-key">
                <span className="ixf-key-n faint">{i + 1}</span>
                <FieldInput
                  value={r.field}
                  fields={fields}
                  onChange={(v) => setRow(i, { field: v })}
                  onOpenChange={onOpenChange}
                  autoFocus={i === 0 && !r.field}
                  placeholder={r.kind === 'wildcard' ? 'path (empty = whole document)' : 'field.path'}
                />
                <select className="select ixf-kind" value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as KeyKind })}>
                  {KEY_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <div className="ixf-key-actions">
                  <button className="btn ghost icon small" title="Move up" disabled={i === 0} onClick={() => moveRow(i, -1)}>
                    <Icon name="chevronDown" size={13} style={{ transform: 'rotate(180deg)' }} />
                  </button>
                  <button className="btn ghost icon small" title="Move down" disabled={i === form.keys.length - 1} onClick={() => moveRow(i, 1)}>
                    <Icon name="chevronDown" size={13} />
                  </button>
                  <button
                    className="btn ghost icon small ixf-remove"
                    title="Remove key"
                    disabled={form.keys.length === 1}
                    onClick={() => setForm((f) => ({ ...f, keys: f.keys.filter((_, j) => j !== i) }))}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button className="btn small ixf-add" onClick={() => setForm((f) => ({ ...f, keys: [...f.keys, { field: '', kind: '1' }] }))}>
            <Icon name="plus" size={12} /> Add key
          </button>
        </Section>

        <Section title="Options">
          <div className="field">
            <label>Name</label>
            <input className="input mono" value={form.name} placeholder={placeholderName} spellCheck={false} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div className="field">
            <label>Behaviour</label>
            <div className="ixf-checks">
              <label className="check" title="Reject documents that duplicate the indexed value(s)">
                <input type="checkbox" checked={form.unique} onChange={(e) => patch({ unique: e.target.checked })} /> Unique
              </label>
              <label className="check" title="Only index documents that contain the indexed field">
                <input type="checkbox" checked={form.sparse} onChange={(e) => patch({ sparse: e.target.checked })} /> Sparse
              </label>
              <label className="check" title="Maintained but ignored by the query planner: test the impact of dropping an index without losing it">
                <input type="checkbox" checked={form.hidden} onChange={(e) => patch({ hidden: e.target.checked })} /> Hidden
              </label>
            </div>
          </div>
          <div className="field">
            <label>TTL</label>
            <div className="ixf-ttl">
              <label className="check" title={ttlPossible ? 'Delete documents automatically once the date in the field is older than this' : 'TTL needs a single ascending or descending date field'}>
                <input type="checkbox" checked={form.ttlEnabled} disabled={!ttlPossible && !form.ttlEnabled} onChange={(e) => patch({ ttlEnabled: e.target.checked })} /> Expire documents
              </label>
              <input
                className="input mono ixf-ttl-input"
                type="number"
                min={0}
                value={form.ttl}
                disabled={!form.ttlEnabled}
                onChange={(e) => patch({ ttl: e.target.value })}
              />
              <span className="muted">seconds</span>
              {form.ttlEnabled && <span className="faint">{duration(Number(form.ttl))}</span>}
              {!ttlPossible && !form.ttlEnabled && <span className="faint">single date field only</span>}
            </div>
          </div>
          <div className="field top">
            <label>Partial filter</label>
            <div className="col" style={{ gap: 3 }}>
              <CodeEditor
                value={form.partialFilter}
                onChange={(v) => patch({ partialFilter: v })}
                fields={fields}
                placeholder="{ status: 'active' }  — only index matching documents"
                minHeight={30}
                maxHeight={120}
                invalid={built.errors.some((e) => e.startsWith('Partial filter:'))}
              />
            </div>
          </div>
          <div className="field">
            <label>Collation</label>
            <div className="ixf-collation">
              <select className="select" value={form.collationLocale} onChange={(e) => patch({ collationLocale: e.target.value })}>
                <option value="">None (collection default)</option>
                {COLLATION_LOCALES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <select
                className="select grow"
                value={form.collationStrength}
                disabled={!form.collationLocale || form.collationLocale === 'simple'}
                onChange={(e) => patch({ collationStrength: Number(e.target.value) })}
                title="Strength: how many levels of difference the comparison considers"
              >
                {COLLATION_STRENGTHS.map((s) => (
                  <option key={s.value} value={s.value}>
                    Strength {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Section>

        {hasText && (
          <Section title="Text index" hint="One text index per collection; it can cover several fields">
            <div className="field">
              <label>Default language</label>
              <select className="select" value={form.defaultLanguage} onChange={(e) => patch({ defaultLanguage: e.target.value })}>
                <option value="">english (default)</option>
                {TEXT_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="field top">
              <label>Weights</label>
              <CodeEditor
                value={form.weights}
                onChange={(v) => patch({ weights: v })}
                fields={form.keys.filter((k) => k.kind === 'text').map((k) => k.field)}
                placeholder="{ title: 10, body: 1 }  — relative importance, default 1"
                minHeight={30}
                maxHeight={100}
                invalid={built.errors.some((e) => e.startsWith('Weights'))}
              />
            </div>
          </Section>
        )}

        {wildcardAll && (
          <Section title="Wildcard projection" hint="Include or exclude paths covered by $**">
            <CodeEditor
              value={form.wildcardProjection}
              onChange={(v) => patch({ wildcardProjection: v })}
              fields={fields}
              placeholder="{ 'attributes': 1 }  or  { 'secret': 0 }"
              minHeight={30}
              maxHeight={100}
              invalid={built.errors.some((e) => e.startsWith('Wildcard projection'))}
            />
          </Section>
        )}

        <Section title="Command">
          <div className="ixf-preview">
            <code className="mono selectable">{command}</code>
            <button
              className="btn ghost icon small"
              title="Copy command"
              onClick={() => api.copyText(command).then(() => toast('Command copied', 'success'))}
            >
              <Icon name="copy" size={13} />
            </button>
          </div>
        </Section>

        {(built.errors.length > 0 || built.warnings.length > 0 || ttlSample || runError) && (
          <div className="ixf-messages">
            {runError && (
              <div className="ixf-msg error">
                <Icon name="warn" size={14} />
                <span className="selectable">
                  <b>The server refused the index:</b> {runError}
                </span>
              </div>
            )}
            {built.errors.map((e) => (
              <div key={e} className="ixf-msg error">
                <Icon name="close" size={14} />
                <span>{e}</span>
              </div>
            ))}
            {[...built.warnings, ...(ttlSample ? [ttlSample] : [])].map((w) => (
              <div key={w} className="ixf-msg warn">
                <Icon name="warn" size={14} />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        <div className={`ixf-load ${large ? 'large' : ''}`}>
          <Icon name="gauge" size={14} />
          <span>
            {large ? (
              <>
                <b>Large collection ({docCount!.toLocaleString()} documents).</b> Building scans every document and adds CPU, I/O and memory load; writes
                continue during the build but slow down. On a busy production server, prefer a quiet period.
              </>
            ) : (
              <>
                Building reads every document{docCount != null && docCount >= 0 ? ` (${docCount.toLocaleString()} here)` : ''} and adds load to the server while it
                runs.
              </>
            )}
          </span>
        </div>
      </div>
    </Modal>
  )
}

/** Rich create-index dialog. Resolves with the index name, or null when cancelled or sent to the background. */
export function openCreateIndexDialog(o: CreateIndexOptions): Promise<string | null> {
  return openModal<string | null>((close) => <CreateIndexBody o={o} close={close} />)
}

/** Key rows from a key document (e.g. an advisor suggestion). */
export const keyRowsFromDoc = (key: Doc): KeyRow[] =>
  Object.entries(key).map(([field, v]) =>
    field === '$**' || field.endsWith('.$**')
      ? { field: field.replace(/\.?\$\*\*$/, ''), kind: 'wildcard' as KeyKind }
      : { field, kind: (Number(v) === -1 ? '-1' : Number(v) === 1 ? '1' : String(v)) as KeyKind }
  )
