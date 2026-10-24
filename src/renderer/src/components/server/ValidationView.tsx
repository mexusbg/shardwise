import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { cellText, isPlainDoc, parseShellValue, shellText } from '@shared/bsonValue'
import { formatValue } from '@shared/pipeline'
import { toJsonSchema } from '@shared/schema'
import type { Doc } from '@shared/api'
import type { ValidationAction, ValidationLevel, ValidationState, ValidationTestResult } from '@shared/serverApi'
import { api } from '../../lib/api'
import { shortcutLabel } from '../../lib/commands'
import { connName, errorText, openCollectionTab, patchTab, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { runQuery } from '../../state/queryActions'
import { applyFind } from '../history/historyActions'
import { CodeEditor } from '../CodeEditor'
import { confirmDialog } from '../Modal'
import { Icon } from '../Icon'
import { serverApi } from './serverClient'
import './server.css'

const LEVELS: { value: ValidationLevel; label: string; info: string }[] = [
  { value: 'strict', label: 'strict', info: 'Validate every insert and update' },
  { value: 'moderate', label: 'moderate', info: 'Validate inserts, and updates to documents that are already valid' },
  { value: 'off', label: 'off', info: 'Do not validate' }
]
const ACTIONS: { value: ValidationAction; label: string; info: string }[] = [
  { value: 'error', label: 'error', info: 'Reject invalid writes' },
  { value: 'warn', label: 'warn', info: 'Allow invalid writes and log a warning' },
  { value: 'errorAndLog', label: 'errorAndLog', info: 'Reject invalid writes and log them (MongoDB 8.1+)' }
]
const GEN_SAMPLES = [100, 500, 1000, 5000]
const SCHEMA_WORDS = ['$jsonSchema', 'bsonType', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'description', 'title', 'anyOf', 'oneOf', 'allOf', 'not']

type Parsed = { value: Doc | null; error: string | null }

function parseValidator(text: string): Parsed {
  if (!text.trim()) return { value: null, error: null }
  try {
    const v = parseShellValue(text)
    return isPlainDoc(v) ? { value: v, error: null } : { value: null, error: 'The validator must be a document: { … }' }
  } catch (e) {
    return { value: null, error: errorText(e) }
  }
}

const keyOf = (p: Parsed): string => (p.value ? shellText(p.value) : '')
const validatorText = (v: Doc | null): string => (v ? shellText(v, 2) : '')

function summary(d: Doc): string {
  return formatValue(Object.fromEntries(Object.entries(d).filter(([k]) => k !== '_id')), 100000).slice(0, 300)
}

interface TestState {
  result?: ValidationTestResult
  /** Validator key and sample size the result belongs to. */
  key?: string
  running?: boolean
  error?: string
}

/** Edit, test and save a collection's validator, validation level and validation action. */
export function ValidationView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const coll = tab.coll ?? ''
  const live = useStore((s) => s.live[connId])
  const connected = !!live
  const [saved, setSaved] = useState<ValidationState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState('')
  const [level, setLevel] = useState<ValidationLevel>('strict')
  const [action, setAction] = useState<ValidationAction>('error')
  const [sample, setSample] = useState('1000')
  const [test, setTest] = useState<TestState>({})
  const [genSize, setGenSize] = useState(1000)
  const [genRequired, setGenRequired] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState(0)
  const [fields, setFields] = useState<string[]>([])

  const applyState = (s: ValidationState): void => {
    setSaved(s)
    setText(validatorText(s.validator))
    setLevel(s.level)
    setAction(s.action)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      applyState(await serverApi.validationGet(connId, db, coll))
      setLoadError(null)
    } catch (e) {
      setLoadError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [connId, db, coll])

  useEffect(() => {
    if (!connected) return
    void load()
    api.sampleFields(connId, db, coll, 100).then(setFields, () => {})
  }, [connected, load, connId, db, coll])

  const parsed = useMemo(() => parseValidator(text), [text])
  const savedText = validatorText(saved?.validator ?? null)
  const savedKey = useMemo(() => keyOf(parseValidator(savedText)), [savedText])
  const key = keyOf(parsed)
  const textDirty = parsed.error ? text !== savedText : key !== savedKey
  const dirty = !!saved && (textDirty || level !== saved.level || action !== saved.action)
  const sampleN = Math.max(0, Math.floor(Number(sample) || 0))
  const testKey = `${key}|${sampleN}`
  const stale = !!test.result && test.key !== testKey
  const completions = useMemo(() => [...fields, ...SCHEMA_WORDS], [fields])
  const actions = saved?.actions ?? ['error', 'warn']

  const revert = (): void => {
    if (saved) applyState(saved)
  }

  const runTest = async (): Promise<ValidationTestResult | null> => {
    if (parsed.error) {
      toast(`Validator: ${parsed.error}`, 'error')
      return null
    }
    const k = testKey
    setTest((t) => ({ ...t, running: true, error: undefined }))
    try {
      const result = await serverApi.validationTest(connId, db, coll, parsed.value ?? {}, sampleN)
      setTest({ result, key: k })
      setSelected(0)
      return result
    } catch (e) {
      setTest({ error: errorText(e), key: k })
      return null
    }
  }

  const generate = async (): Promise<void> => {
    if (text.trim() && text !== savedText) {
      const ok = await confirmDialog({ title: 'Replace validator?', message: 'The generated $jsonSchema replaces the validator you are editing.', confirmLabel: 'Replace' })
      if (!ok) return
    }
    setGenerating(true)
    try {
      const report = await api.analyzeSample(connId, db, coll, genSize)
      if (!report.docCount) return toast(`${coll} has no documents to learn a schema from`, 'error')
      const schema = toJsonSchema(report, { required: genRequired ? 'always-present' : 'none' })
      setText(shellText({ $jsonSchema: schema }, 2))
      toast(`Schema generated from ${report.docCount.toLocaleString()} documents. Review it, then test it.`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setGenerating(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!saved) return
    if (parsed.error) return toast(`Validator: ${parsed.error}`, 'error')
    let result = test.result && test.key === testKey ? test.result : null
    const enforcing = !!parsed.value && level !== 'off' && action !== 'warn'
    if (enforcing && !result) result = await runTest()
    const failures = result?.failed ?? 0
    const risky = level === 'strict' && action !== 'warn' && failures > 0
    const ok = await confirmDialog({
      title: 'Save validation rules?',
      danger: risky,
      confirmLabel: risky ? 'Save anyway' : 'Save',
      message: (
        <div className="col">
          <div>
            {parsed.value ? (
              <>
                Set the validator of <b>{coll}</b> with level <b>{level}</b> and action <b>{action}</b>.
              </>
            ) : (
              <>
                The validator is empty: <b>{coll}</b> will have no validation rules.
              </>
            )}
          </div>
          {result && parsed.value && (
            <div className={failures ? 'error-text' : 'muted'}>
              {failures
                ? `${failures.toLocaleString()} of ${result.sampled.toLocaleString()} sampled documents fail this validator.`
                : `All ${result.sampled.toLocaleString()} sampled documents pass.`}
            </div>
          )}
          {risky && <div className="notice">With strict / {action}, any update to those documents is rejected until they are fixed. Consider moderate or warn first.</div>}
          {!risky && failures > 0 && level === 'moderate' && <div className="muted">With moderate, existing invalid documents can still be updated; new and valid documents are checked.</div>}
        </div>
      )
    })
    if (!ok) return
    setSaving(true)
    try {
      applyState(await serverApi.validationSet(connId, db, coll, { validator: parsed.value, level, action }))
      toast(`Validation rules of ${coll} saved`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Remove validation?',
      message: (
        <>
          Remove the validator of <b>{coll}</b>? Inserts and updates are no longer checked. The level and action reset to strict / error.
        </>
      ),
      confirmLabel: 'Remove validation',
      danger: true
    })
    if (!ok) return
    setSaving(true)
    try {
      applyState(await serverApi.validationSet(connId, db, coll, { validator: null, level: 'strict', action: 'error' }))
      setTest({})
      toast(`Validation removed from ${coll}`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const openQuery = async (query: string): Promise<void> => {
    const id = openCollectionTab(connId, db, coll)
    // `loading` keeps the new tab from applying its default query on mount.
    patchTab(id, { loading: true })
    applyFind(id, { kind: 'find', query, projection: '', sort: '', skip: '', limit: '' }, false)
    await runQuery(id)
    patchTab(id, (t) => (t.loading && !t.docs ? { loading: false } : {}))
  }

  const openDoc = (d: Doc): void => void openQuery(`{ _id: ${shellText(d._id)} }`)
  const openAllFailing = (): void => {
    if (parsed.value) void openQuery(`{ $nor: [${shellText(parsed.value, 2)}] }`)
  }

  const r = test.result
  const failures = r?.failures ?? []
  const sel = failures[Math.min(selected, failures.length - 1)]
  const levelInfo = LEVELS.find((l) => l.value === level)?.info
  const actionInfo = ACTIONS.find((a) => a.value === action)?.info

  return (
    <div className="vl">
      <div className="vl-head">
        <Icon name="shield" size={16} className="vl-head-icon" />
        <span className="vl-title">Validation rules</span>
        <span className="vl-saved">
          <span className="faint ellipsis">
            {connName(connId)} · {db}.<b>{coll}</b>
          </span>
          {saved &&
            (saved.validator ? (
              <span className="vl-chip on" title="Saved state">
                <Icon name="check" size={11} /> {saved.level} / {saved.action}
              </span>
            ) : (
              <span className="vl-chip" title="Saved state">
                no validation
              </span>
            ))}
          {dirty && (
            <span className="vl-chip dirty">
              <i /> unsaved changes
            </span>
          )}
        </span>
        <span className="spacer" />
        {loading && <span className="sv-spin" />}
        <button className="btn ghost small" onClick={revert} disabled={!dirty || saving} title="Discard the edits and show the saved rules">
          <Icon name="refresh" size={13} /> Revert
        </button>
        <button className="btn small danger" onClick={() => void remove()} disabled={!connected || !saved?.validator || saving} title="Remove the validator from the collection">
          <Icon name="trash" size={13} /> Remove validation
        </button>
        <button className="btn primary small" onClick={() => void save()} disabled={!connected || !saved || !dirty || saving || !!parsed.error}>
          <Icon name="check" size={13} /> Save
        </button>
      </div>

      {loadError && <div className="notice error selectable" style={{ margin: 10 }}>{loadError}</div>}

      <div className="vl-bar">
        <label title={levelInfo}>
          Level
          <select className={`select small ${saved && level !== saved.level ? 'changed' : ''}`} value={level} onChange={(e) => setLevel(e.target.value as ValidationLevel)}>
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value} title={l.info}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label title={actionInfo}>
          Action
          <select className={`select small ${saved && action !== saved.action ? 'changed' : ''}`} value={action} onChange={(e) => setAction(e.target.value as ValidationAction)}>
            {ACTIONS.filter((a) => actions.includes(a.value) || a.value === action).map((a) => (
              <option key={a.value} value={a.value} title={a.info}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <span className="faint">
          {levelInfo}; {actionInfo?.toLowerCase()}.
        </span>
        <span className="spacer" />
        <label title="Number of random documents to learn the schema from">
          <select className="select small" value={genSize} onChange={(e) => setGenSize(Number(e.target.value))}>
            {GEN_SAMPLES.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} docs
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="List fields present in every sampled document as required">
          <input type="checkbox" checked={genRequired} onChange={(e) => setGenRequired(e.target.checked)} /> Required fields
        </label>
        <button className="btn small" onClick={() => void generate()} disabled={!connected || generating}>
          <Icon name="schema" size={13} /> {generating ? 'Generating…' : 'Generate from schema'}
        </button>
      </div>

      <div className="vl-main">
        <div className="vl-editor">
          <div className="vl-editor-head">
            <b>Validator</b>
            <span className="faint ellipsis">Shell syntax: a $jsonSchema or query operators such as {'{ qty: { $gte: 0 } }'}</span>
          </div>
          <CodeEditor
            value={text}
            onChange={setText}
            onSubmit={() => void runTest()}
            fields={completions}
            full
            invalid={!!parsed.error}
            className="vl-code"
            placeholder="{ $jsonSchema: { bsonType: 'object', required: ['name'], properties: { name: { bsonType: 'string' } } } }"
          />
          {parsed.error ? (
            <div className="vl-error selectable">{parsed.error}</div>
          ) : (
            <div className="vl-hint">
              An empty validator means no validation.
              {shortcutLabel('editor.submit') && (
                <>
                  {' '}
                  Press <span className="kbd">{shortcutLabel('editor.submit')}</span> to test against a sample.
                </>
              )}
            </div>
          )}
        </div>

        <div className="vl-results">
          <div className="vl-results-head">
            <b>Test</b>
            <span className="spacer" />
            <label className="row faint" title="Random documents to check (0 = the whole collection)">
              Sample
              <input className="input small vl-num" value={sample} onChange={(e) => setSample(e.target.value.replace(/\D/g, ''))} />
              docs
            </label>
            <button className="btn small primary" onClick={() => void runTest()} disabled={!connected || test.running || !!parsed.error}>
              <Icon name="play" size={12} /> {test.running ? 'Testing…' : 'Test against sample'}
            </button>
          </div>
          <div className="vl-results-body">
            {test.error ? (
              <div className="notice error selectable" style={{ margin: 10 }}>
                {test.error}
              </div>
            ) : !r ? (
              <div className="vl-empty">
                {test.running ? 'Checking documents…' : 'Count how many existing documents would fail the edited validator, before you save it.'}
              </div>
            ) : (
              <>
                <div className="vl-summary">
                  <div className="vl-counts">
                    <span className="vl-count pass">
                      <b>{r.passed.toLocaleString()}</b>
                      <span>pass</span>
                    </span>
                    <span className="vl-count fail">
                      <b>{r.failed.toLocaleString()}</b>
                      <span>fail</span>
                    </span>
                    <span className="faint small-text">
                      of {r.sampled.toLocaleString()} {r.sampled < r.total ? `sampled (≈${r.total.toLocaleString()} in ${coll})` : 'documents'} · {r.ms.toLocaleString()} ms
                    </span>
                  </div>
                  {r.sampled > 0 && (
                    <div className="vl-split" title={`${((r.failed / r.sampled) * 100).toFixed(1)}% fail`}>
                      {r.passed > 0 && <div className="pass" style={{ flex: r.passed }} />}
                      {r.failed > 0 && <div className="fail" style={{ flex: r.failed }} />}
                    </div>
                  )}
                  {stale && (
                    <div className="vl-stale">
                      <Icon name="warn" size={12} /> The validator or sample changed since this test. Run it again.
                    </div>
                  )}
                </div>
                {failures.length > 0 && (
                  <div className="vl-fails">
                    <div className="vl-fails-head">
                      Failing documents{r.failed > failures.length ? ` (first ${failures.length})` : ''}
                      <span className="spacer" />
                      <button className="btn ghost small" onClick={openAllFailing} disabled={!parsed.value} title="Open a query tab with { $nor: [validator] }: every document that fails">
                        <Icon name="search" size={12} /> Query all failing
                      </button>
                    </div>
                    {failures.map((d, i) => (
                      <div key={i} className={`vl-fail ${d === sel ? 'sel' : ''}`} onClick={() => setSelected(i)} onDoubleClick={() => openDoc(d)} title="Double-click to open in a query tab">
                        <span className="mono">{cellText(d._id)}</span>
                        <span className="vl-fail-text">{summary(d)}</span>
                        <button
                          className="btn ghost small"
                          onClick={(e) => {
                            e.stopPropagation()
                            openDoc(d)
                          }}
                        >
                          Open
                        </button>
                      </div>
                    ))}
                    {sel && (
                      <div className="vl-doc">
                        <CodeEditor key={shellText(sel._id)} value={shellText(sel, 2)} readOnly full />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
