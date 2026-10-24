import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { EJSON } from 'bson'
import { bsonTypeOf, shellText, TYPE_LABELS } from '@shared/bsonValue'
import { FAKE_LABELS, isProfile, MASK_LABELS, randomSalt, ruleDefaults, suggestRule } from '@shared/masking'
import type { FakeKind, MaskKind, MaskProfile, MaskRule, PreviewPair } from '@shared/maskingApi'
import { api } from '../../lib/api'
import { connName, errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { promptDialog } from '../Modal'
import { FilterBox, fmt, JobStrip, PairsPreview, parseConstant, parsedFilter, useDebounced, useJob, useSampledFields } from './common'
import type { FieldInfo } from './common'
import { maskingApi } from './maskingClient'
import { openMaskRunDialog } from './MaskRunDialog'
import './masking.css'

const KINDS = Object.keys(MASK_LABELS) as MaskKind[]
const FAKES = Object.keys(FAKE_LABELS) as FakeKind[]

interface Row {
  rule: MaskRule
  /** Text of a `constant` value as typed. */
  constText?: string
  custom?: boolean
}

const num = (s: string, fallback = 0): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

function NumberInput({ value, onChange, width = 58, title, min, step }: { value: number | undefined; onChange: (n: number) => void; width?: number; title?: string; min?: number; step?: number }): ReactElement {
  const [text, setText] = useState(String(value ?? ''))
  useEffect(() => {
    if (num(text, NaN) !== value) setText(String(value ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input
      className="input small mono"
      type="number"
      style={{ width }}
      value={text}
      title={title}
      min={min}
      step={step}
      onChange={(e) => {
        setText(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value))
      }}
    />
  )
}

function Consistent({ rule, patch }: { rule: MaskRule; patch: (p: Partial<MaskRule>) => void }): ReactElement {
  return (
    <label className="check mk-small" title="The same original value always gets the same masked value (seeded from its hash and the salt)">
      <input type="checkbox" checked={!!rule.consistent} onChange={(e) => patch({ consistent: e.target.checked })} /> consistent
    </label>
  )
}

function RuleOptions({ row, patch, setConst }: { row: Row; patch: (p: Partial<MaskRule>) => void; setConst: (t: string) => void }): ReactElement | null {
  const r = row.rule
  switch (r.kind) {
    case 'redact':
      return <input className="input small mono" style={{ width: 110 }} value={r.text ?? '***'} onChange={(e) => patch({ text: e.target.value })} title="Replacement text" />
    case 'partial':
      return (
        <>
          <div className="segmented small">
            <button className={r.partial !== 'email' ? 'on' : ''} onClick={() => patch({ partial: 'chars' })}>
              Chars
            </button>
            <button className={r.partial === 'email' ? 'on' : ''} onClick={() => patch({ partial: 'email', keepStart: r.keepStart || 1 })}>
              Email
            </button>
          </div>
          <span className="faint mk-small">first</span>
          <NumberInput value={r.keepStart ?? 0} onChange={(n) => patch({ keepStart: Math.max(0, Math.floor(n)) })} width={46} min={0} />
          {r.partial !== 'email' && (
            <>
              <span className="faint mk-small">last</span>
              <NumberInput value={r.keepEnd ?? 0} onChange={(n) => patch({ keepEnd: Math.max(0, Math.floor(n)) })} width={46} min={0} />
              <input className="input small mono" style={{ width: 30, textAlign: 'center' }} maxLength={1} value={r.maskChar ?? '*'} onChange={(e) => patch({ maskChar: e.target.value || '*' })} title="Mask character" />
              <label className="check mk-small" title="Spaces, dashes and other separators stay visible">
                <input type="checkbox" checked={r.keepSeparators !== false} onChange={(e) => patch({ keepSeparators: e.target.checked })} /> separators
              </label>
            </>
          )}
        </>
      )
    case 'hash':
      return <input className="input small mono" style={{ width: 150 }} value={r.salt ?? ''} placeholder="profile salt" onChange={(e) => patch({ salt: e.target.value || undefined })} title="Salt for this field (default: the profile salt)" />
    case 'fake':
      return (
        <>
          <select className="select small" value={r.fake ?? 'fullName'} onChange={(e) => patch({ fake: e.target.value as FakeKind })}>
            {FAKES.map((f) => (
              <option key={f} value={f}>
                {FAKE_LABELS[f]}
              </option>
            ))}
          </select>
          <Consistent rule={r} patch={patch} />
        </>
      )
    case 'number':
      return (
        <>
          <NumberInput value={r.min} onChange={(n) => patch({ min: n })} width={70} title="Minimum" />
          <span className="faint">–</span>
          <NumberInput value={r.max} onChange={(n) => patch({ max: n })} width={70} title="Maximum" />
          <span className="faint mk-small">dec.</span>
          <NumberInput value={r.decimals ?? 0} onChange={(n) => patch({ decimals: Math.max(0, Math.min(10, Math.floor(n))) })} width={42} min={0} title="Decimals" />
          <Consistent rule={r} patch={patch} />
        </>
      )
    case 'noise':
      return (
        <>
          <span className="faint">±</span>
          <NumberInput value={r.percent} onChange={(n) => patch({ percent: Math.abs(n) })} width={56} min={0} />
          <span className="faint mk-small">%</span>
          <Consistent rule={r} patch={patch} />
        </>
      )
    case 'dateShift':
      return (
        <>
          <span className="faint">±</span>
          <NumberInput value={r.days} onChange={(n) => patch({ days: Math.max(0, Math.floor(Math.abs(n))) })} width={56} min={0} />
          <span className="faint mk-small">days</span>
          <Consistent rule={r} patch={patch} />
        </>
      )
    case 'constant': {
      const v = parseConstant(row.constText ?? '')
      return (
        <>
          <input className="input small mono grow" value={row.constText ?? ''} placeholder="'N/A', 0, ISODate('2020-01-01')…" onChange={(e) => setConst(e.target.value)} title="Shell syntax; anything else is a string" />
          <span className="type-tag">{TYPE_LABELS[bsonTypeOf(v)]}</span>
        </>
      )
    }
    default:
      return null
  }
}

const profileOf = (salt: string, rows: Row[]): MaskProfile => ({
  format: 'shardwise-mask-profile',
  version: 1,
  salt,
  rules: rows.filter((r) => r.rule.kind !== 'keep').map((r) => r.rule)
})

/** Mask a collection's documents field by field and copy, export or overwrite them. */
export function MaskingView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const coll = tab.coll ?? ''
  const connected = useStore((s) => !!s.live[connId])
  const sampled = useSampledFields(connId, db, coll, connected)
  const [rows, setRows] = useState<Row[]>([])
  const [salt, setSalt] = useState(randomSalt)
  const [filterText, setFilterText] = useState('')
  const [search, setSearch] = useState('')
  const [maskedOnly, setMaskedOnly] = useState(false)
  const [pairs, setPairs] = useState<PreviewPair[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId)
  const info = useMemo(() => new Map(sampled.fields.map((f) => [f.path, f])), [sampled.fields])

  // Merge sampled fields into the rule rows (existing rules are kept).
  useEffect(() => {
    if (!sampled.fields.length) return
    setRows((prev) => {
      const byPath = new Map(prev.map((r) => [r.rule.path, r]))
      const out: Row[] = sampled.fields.map((f) => byPath.get(f.path) ?? { rule: { path: f.path, kind: 'keep' } })
      for (const r of prev) if (!info.has(r.rule.path)) out.push({ ...r, custom: true })
      return out
    })
  }, [sampled.fields, info])

  const filter = parsedFilter(filterText)
  const rules = useMemo(() => rows.map((r) => r.rule).filter((r) => r.kind !== 'keep'), [rows])
  const req = useDebounced(JSON.stringify({ filterText, salt, rules: EJSON.stringify(rules as never, { relaxed: false }) }), 350)

  const seq = useRef(0)
  const refresh = async (): Promise<void> => {
    if (!connected || filter === undefined) return
    const n = ++seq.current
    setLoading(true)
    try {
      const res = await maskingApi.maskingPreview({ connId, db, coll, filter }, rules, salt, 20)
      if (n !== seq.current) return
      setPairs(res)
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
  }, [req, connected])

  const patchRow = (path: string, p: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.rule.path === path ? { ...r, ...p } : r)))
  const patchRule = (path: string, p: Partial<MaskRule>): void => setRows((rs) => rs.map((r) => (r.rule.path === path ? { ...r, rule: { ...r.rule, ...p } } : r)))
  const setKind = (path: string, kind: MaskKind): void =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.rule.path !== path || r.rule.kind === kind) return r
        if (kind === 'constant') return { ...r, rule: { path, kind, value: 'N/A' }, constText: "'N/A'" }
        return { ...r, rule: ruleDefaults(path, kind) }
      })
    )

  const suggest = (): void => {
    let n = 0
    const next = rows.map((r) => {
      if (r.rule.kind !== 'keep') return r
      const rule = suggestRule(r.rule.path, info.get(r.rule.path)?.type)
      if (rule.kind === 'keep') return r
      n++
      return { ...r, rule }
    })
    setRows(next)
    toast(n ? `Suggested rules for ${n} field${n === 1 ? '' : 's'} — review them before running` : 'No new suggestions: the field names give no hints')
  }

  const resetAll = (): void => setRows((rs) => rs.filter((r) => !r.custom).map((r) => ({ rule: { path: r.rule.path, kind: 'keep' } })))

  const addPath = async (): Promise<void> => {
    const p = await promptDialog({
      title: 'Add field path',
      label: 'Dot path (array levels are traversed, e.g. items.sku)',
      placeholder: 'profile.taxId',
      validate: (v) => (!v.trim() || v.split('.').some((s) => !s.trim()) ? 'Enter a dot path' : rows.some((r) => r.rule.path === v.trim()) ? 'Already listed' : null)
    })
    if (p) setRows((rs) => [...rs, { rule: { path: p.trim(), kind: 'redact', text: '***' }, custom: true }])
  }

  const saveProfile = async (): Promise<void> => {
    const path = await api.saveFile({ title: 'Save masking profile', defaultPath: `${coll}.mask.json`, filters: [{ name: 'Masking profile', extensions: ['json'] }] })
    if (!path) return
    try {
      await api.writeTextFile(path, EJSON.stringify(profileOf(salt, rows) as never, undefined, 2, { relaxed: false }))
      toast(`Saved ${rules.length} rule${rules.length === 1 ? '' : 's'} to ${path.split(/[\\/]/).pop()}`, 'success')
    } catch (e) {
      toast(`Could not save the profile: ${errorText(e)}`, 'error')
    }
  }

  const loadProfile = async (): Promise<void> => {
    const paths = await api.openFile({ title: 'Load masking profile', filters: [{ name: 'Masking profile', extensions: ['json'] }] })
    if (!paths?.[0]) return
    try {
      const parsed = EJSON.parse(await api.readTextFile(paths[0]), { relaxed: false })
      if (!isProfile(parsed)) throw new Error('Not a Shardwise masking profile')
      setSalt(parsed.salt ?? '')
      setRows((rs) => {
        const loaded = new Map(parsed.rules.map((r) => [r.path, r]))
        const out: Row[] = rs.filter((r) => !r.custom).map((r) => {
          const l = loaded.get(r.rule.path)
          return l ? { rule: l, constText: l.kind === 'constant' ? shellText(l.value) : undefined } : { rule: { path: r.rule.path, kind: 'keep' } }
        })
        for (const r of parsed.rules) if (!out.some((o) => o.rule.path === r.path)) out.push({ rule: r, custom: true, constText: r.kind === 'constant' ? shellText(r.value) : undefined })
        return out
      })
      toast(`Loaded ${parsed.rules.length} rule${parsed.rules.length === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      toast(`Could not load the profile: ${errorText(e)}`, 'error')
    }
  }

  const run = async (): Promise<void> => {
    if (filter === undefined) return toast('The filter is not valid', 'error')
    if (!rules.length) return toast('Choose a rule for at least one field', 'error')
    const id = await openMaskRunDialog({ connId, db, coll, filter }, rules, salt)
    if (id) setJobId(id)
  }

  const running = job?.state === 'running'
  useEffect(() => {
    if (job && job.state !== 'running') void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.state])

  const q = search.trim().toLowerCase()
  const visible = rows.filter((r) => (!maskedOnly || r.rule.kind !== 'keep') && (!q || r.rule.path.toLowerCase().includes(q)))
  const fieldNames = useMemo(() => sampled.fields.map((f) => f.path), [sampled.fields])

  if (!connected)
    return (
      <div className="mk">
        <div className="mk-empty">
          <Icon name="unplug" size={34} />
          <h3>Disconnected</h3>
          <p className="muted">Reconnect to mask {coll}.</p>
        </div>
      </div>
    )

  return (
    <div className="mk">
      <div className="mk-head">
        <Icon name="mask" size={16} className="mk-head-icon" />
        <span className="mk-title ellipsis" title={`${connName(connId)} · ${db}.${coll}`}>
          Data Masking <span className="faint">{db}.</span>
          {coll}
        </span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => void loadProfile()} title="Load rules and salt from a profile file">
          <Icon name="import" size={13} /> Load profile
        </button>
        <button className="btn small ghost" onClick={() => void saveProfile()} disabled={!rules.length} title="Save rules and salt to a profile file">
          <Icon name="export" size={13} /> Save profile
        </button>
        <span className="mk-head-sep" />
        <button className="btn small primary" onClick={() => void run()} disabled={!rules.length || filter === undefined || running} title={rules.length ? 'Copy, export or mask in place' : 'Choose a rule for at least one field'}>
          <Icon name="play" size={13} /> Run…
        </button>
      </div>

      <div className="mk-body">
        <section className="mk-left">
          <div className="mk-setup">
            <div className="mk-setup-row">
              <label className="mk-label">Filter</label>
              <FilterBox value={filterText} onChange={setFilterText} fields={fieldNames} onSubmit={() => void refresh()} />
            </div>
            <div className="mk-setup-row">
              <label className="mk-label" title="Mixed into hashes and consistent fakes. Keep it (save a profile) to reproduce the same output and keep joins across collections.">
                Salt
              </label>
              <div className="row grow">
                <input className="input small mono grow" value={salt} onChange={(e) => setSalt(e.target.value)} spellCheck={false} placeholder="(none — plain SHA-256)" />
                <button className="btn small icon ghost" onClick={() => setSalt(randomSalt())} title="New random salt">
                  <Icon name="refresh" size={13} />
                </button>
              </div>
            </div>
          </div>

          <div className="mk-rules-bar">
            <div className="mk-search">
              <Icon name="search" size={12} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find field" spellCheck={false} />
            </div>
            <label className="check mk-small">
              <input type="checkbox" checked={maskedOnly} onChange={(e) => setMaskedOnly(e.target.checked)} /> Masked only
            </label>
            <span className="spacer" />
            <span className="faint mk-small">
              {fmt(rules.length)} / {fmt(rows.length)} masked
            </span>
            <button className="btn small" onClick={suggest} disabled={!rows.length} title="Suggest rules from field names (email, phone, card, password…) for fields still kept">
              <Icon name="sparkle" size={13} /> Suggest
            </button>
            <button className="btn small ghost icon" onClick={() => void addPath()} title="Add a field path not in the sample">
              <Icon name="plus" size={13} />
            </button>
            <button className="btn small ghost icon" onClick={resetAll} disabled={!rules.length} title="Keep every field">
              <Icon name="trash" size={13} />
            </button>
          </div>

          <div className="mk-rules">
            {sampled.loading && !rows.length && (
              <div className="mk-preview-empty">
                <span className="mk-spinner" />
              </div>
            )}
            {sampled.error && <div className="notice error mk-preview-msg">{sampled.error}</div>}
            {!sampled.loading && !sampled.error && !rows.length && <div className="mk-preview-empty">The collection is empty: add field paths by hand.</div>}
            {visible.map((row) => {
              const f: FieldInfo | undefined = info.get(row.rule.path)
              const masked = row.rule.kind !== 'keep'
              return (
                <div key={row.rule.path} className={`mk-rule ${masked ? 'masked' : ''} k-${row.rule.kind}`}>
                  <div className="mk-rule-field" style={{ paddingLeft: 8 + (f?.depth ?? 0) * 14 }}>
                    <span className="mono ellipsis mk-rule-path" title={row.rule.path}>
                      {f && f.depth > 0 ? <span className="faint">{row.rule.path.split('.').slice(0, -1).join('.')}.</span> : null}
                      {row.rule.path.split('.').pop()}
                    </span>
                    <span className="mk-rule-meta">
                      {f ? (
                        <>
                          <span className={`type-tag t-${f.type}`}>{f.typeLabel}</span>
                          {f.presence < 0.995 && <span className="type-tag">{Math.round(f.presence * 100)}%</span>}
                        </>
                      ) : (
                        <span className="type-tag">custom</span>
                      )}
                    </span>
                  </div>
                  <select className="select small mk-rule-kind" value={row.rule.kind} onChange={(e) => setKind(row.rule.path, e.target.value as MaskKind)}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {MASK_LABELS[k]}
                      </option>
                    ))}
                  </select>
                  <div className="mk-rule-opts">
                    <RuleOptions
                      row={row}
                      patch={(p) => patchRule(row.rule.path, p)}
                      setConst={(t) => patchRow(row.rule.path, { constText: t, rule: { ...row.rule, value: parseConstant(t) } })}
                    />
                    {row.custom && (
                      <button className="btn small ghost icon mk-rule-del" onClick={() => setRows((rs) => rs.filter((r) => r.rule.path !== row.rule.path))} title="Remove this path">
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="mk-right">
          <PairsPreview
            pairs={pairs}
            loading={loading}
            error={filter === undefined ? 'The filter is not valid shell syntax' : error}
            focus={rules.map((r) => r.path)}
            title="Preview"
            empty="Loading the first documents…"
            actions={
              <button className="btn small ghost icon" onClick={() => void refresh()} title="Refresh the preview">
                <Icon name="refresh" size={13} />
              </button>
            }
          />
        </section>
      </div>
      <JobStrip job={job} onCancel={() => jobId && void maskingApi.maskingCancel(jobId)} onDismiss={() => setJobId(null)} />
    </div>
  )
}
