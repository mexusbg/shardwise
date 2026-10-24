import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AppSettings, MongoshStatus, ShellConfirmMode } from '@shared/api'
import {
  SHELL_BATCH_MAX,
  SHELL_BATCH_MIN,
  SHELL_DEPTH_MAX,
  SHELL_DEPTH_MIN,
  SHELL_HISTORY_MAX,
  SHELL_HISTORY_MIN,
  SHELL_OUTPUT_CHARS_MAX,
  SHELL_OUTPUT_CHARS_MIN,
  SHELL_OUTPUT_LINES_MAX,
  SHELL_OUTPUT_LINES_MIN,
  SHELL_TIMEOUT_MAX
} from '@shared/shellOptions'
import { clampInt } from '@shared/settings'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { confirmDialog } from '../Modal'
import { clearShellHistory, shellHistoryCount } from './shellHistory'

type SetS = (s: AppSettings) => void

function Field({ id, label, hint, top, children }: { id: string; label: ReactNode; hint?: ReactNode; top?: boolean; children: ReactNode }): ReactElement {
  return (
    <div className={`field ${top ? 'top' : ''}`} data-pref={id}>
      <label>{label}</label>
      <div style={{ minWidth: 0 }}>
        {children}
        {hint && <div className="pref-hint">{hint}</div>}
      </div>
    </div>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }): ReactElement {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }): ReactElement {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

/** Whole-number input that keeps what is typed and stores the clamped value. */
function IntInput({ value, min, max, step, width = 110, suffix, onChange }: { value: number; min: number; max: number; step?: number; width?: number; suffix?: string; onChange: (v: number) => void }): ReactElement {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText(String(value))
  }, [value])
  return (
    <span className="row" style={{ gap: 6 }}>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        style={{ width }}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(clampInt(e.target.value, min, max, value))
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="muted">{suffix}</span>}
    </span>
  )
}

/** Seconds input for a time limit stored in ms; empty / 0 = none. */
function SecondsInput({ ms, onChange }: { ms: number; onChange: (ms: number) => void }): ReactElement {
  const [text, setText] = useState(ms ? String(ms / 1000) : '')
  useEffect(() => {
    setText(ms ? String(ms / 1000) : '')
  }, [ms])
  return (
    <span className="row" style={{ gap: 6 }}>
      <input
        className="input"
        style={{ width: 110 }}
        value={text}
        placeholder="no limit"
        onChange={(e) => {
          setText(e.target.value)
          const sec = Number(e.target.value.replace(',', '.'))
          onChange(Number.isFinite(sec) && sec > 0 ? Math.min(SHELL_TIMEOUT_MAX, Math.round(sec * 1000)) : 0)
        }}
        onBlur={() => setText(ms ? String(ms / 1000) : '')}
      />
      <span className="muted">seconds</span>
    </span>
  )
}

const CONFIRM_OPTIONS: [ShellConfirmMode, string][] = [
  ['off', 'Never'],
  ['destructive', 'Destructive commands'],
  ['writes', 'Every write']
]

function MongoshField({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const [status, setStatus] = useState<MongoshStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const check = (path: string): void => {
    setChecking(true)
    api
      .mongoshStatus(path)
      .then(setStatus, (e) => setStatus({ found: false, error: errorText(e) }))
      .finally(() => setChecking(false))
  }
  useEffect(() => {
    check(s.mongoshPath)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Field id="mongoshPath" label="mongosh" hint="Used by Open in mongosh (connection and database menus). Empty = find it on PATH or in the usual install folders.">
        <div className="row">
          <input className="input grow mono" value={s.mongoshPath} placeholder="auto-detect" onChange={(e) => setS({ ...s, mongoshPath: e.target.value })} onBlur={(e) => check(e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const r = await api.openFile({ title: 'mongosh executable' })
              if (r?.[0]) {
                setS({ ...s, mongoshPath: r[0] })
                check(r[0])
              }
            }}
          >
            Browse…
          </button>
          <button className="btn" disabled={checking} onClick={() => check(s.mongoshPath)}>
            {checking ? 'Checking…' : 'Detect'}
          </button>
        </div>
      </Field>
      <div className="field">
        <label />
        <div className="muted" data-testid="mongosh-status">
          {status === null ? (
            'Looking for mongosh…'
          ) : status.found ? (
            <>
              mongosh {status.version} at <span className="mono">{status.path}</span>
              {status.source === 'path' ? ' (on PATH)' : status.source === 'common' ? ' (install folder)' : ''}
            </>
          ) : (
            <span className="error-text">{status.error ?? 'mongosh was not found'}</span>
          )}
        </div>
      </div>
    </>
  )
}

/** Settings → Shell & Playground: startup script, output, confirmations, history, time limits and external mongosh. */
export function ShellSettings({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const [stored, setStored] = useState(() => shellHistoryCount())
  return (
    <>
      <div className="section-title">Startup script</div>
      <Field
        id="shellStartupScript"
        label="Run at start"
        top
        hint="Runs whenever a shell session starts or restarts, like .mongoshrc: define helpers, set variables. Errors are shown in the shell; the session still starts. A connection can add its own script (connection settings → Behavior)."
      >
        <div className="col" style={{ gap: 8 }}>
          <div style={{ alignSelf: 'flex-start' }}>
            <Segmented value={s.shellStartupSource} options={[['inline', 'Script'], ['file', 'File']] as const} onChange={(shellStartupSource) => setS({ ...s, shellStartupSource })} />
          </div>
          {s.shellStartupSource === 'inline' ? (
            <CodeEditor value={s.shellStartupScript} onChange={(v) => setS({ ...s, shellStartupScript: v })} full area="shell" minHeight={90} maxHeight={220} placeholder="// e.g. const recent = (c) => db[c].find().sort({ _id: -1 }).limit(5)" />
          ) : (
            <div className="row">
              <input className="input grow mono" value={s.shellStartupFile} placeholder="Path of a .js file" onChange={(e) => setS({ ...s, shellStartupFile: e.target.value })} />
              <button
                className="btn"
                onClick={async () => {
                  const r = await api.openFile({ title: 'Shell startup script', filters: [{ name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'] }, { name: 'All files', extensions: ['*'] }] })
                  if (r?.[0]) setS({ ...s, shellStartupFile: r[0] })
                }}
              >
                Browse…
              </button>
            </div>
          )}
        </div>
      </Field>
      <Field id="playgroundRunStartup" label="Playground">
        <Check checked={s.playgroundRunStartup} onChange={(v) => setS({ ...s, playgroundRunStartup: v })}>
          Also run the startup script before playground scripts
        </Check>
      </Field>

      <div className="section-title">Output</div>
      <Field id="shellBatchSize" label="Results per page" hint="Documents a cursor shows at a time; it shows the next page.">
        <IntInput value={s.shellBatchSize} min={SHELL_BATCH_MIN} max={SHELL_BATCH_MAX} onChange={(v) => setS({ ...s, shellBatchSize: v })} suffix="documents" />
      </Field>
      <Field id="shellMaxOutputLines" label="Output per command" hint="Console output and text results beyond this are cut, with Show more.">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <IntInput value={s.shellMaxOutputLines} min={SHELL_OUTPUT_LINES_MIN} max={SHELL_OUTPUT_LINES_MAX} step={100} onChange={(v) => setS({ ...s, shellMaxOutputLines: v })} suffix="lines" />
          <IntInput value={s.shellMaxOutputChars} min={SHELL_OUTPUT_CHARS_MIN} max={SHELL_OUTPUT_CHARS_MAX} step={10000} width={130} onChange={(v) => setS({ ...s, shellMaxOutputChars: v })} suffix="characters" />
        </div>
      </Field>
      <Field id="shellPrintDepth" label="Nesting depth" hint="Deeper documents print as [Object] in console output and start folded in results.">
        <IntInput value={s.shellPrintDepth} min={SHELL_DEPTH_MIN} max={SHELL_DEPTH_MAX} width={80} onChange={(v) => setS({ ...s, shellPrintDepth: v })} suffix="levels" />
      </Field>
      <Field id="shellNumberDisplay" label="Numbers" hint={s.shellNumberDisplay === 'typed' ? "NumberInt('5'), NumberLong('7'), NumberDecimal('1.5')" : '5, 7, 1.5 (the type is not shown)'}>
        <Segmented value={s.shellNumberDisplay} options={[['typed', 'With type'], ['plain', 'Plain']] as const} onChange={(shellNumberDisplay) => setS({ ...s, shellNumberDisplay })} />
      </Field>
      <Field id="shellDateDisplay" label="Dates" hint={s.shellDateDisplay === 'iso' ? "ISODate('2026-01-05T10:00:00.000Z')" : 'In the zone and format of Settings → Dates & time zones'}>
        <Segmented value={s.shellDateDisplay} options={[['iso', 'ISODate()'], ['data', 'Dates & times setting']] as const} onChange={(shellDateDisplay) => setS({ ...s, shellDateDisplay })} />
      </Field>

      <div className="section-title">Safety</div>
      <Field
        id="shellConfirm"
        label="Ask before running"
        top
        hint="Covers db and collection methods and runCommand; the driver client, getMongo() and Mongoose models are not checked. Startup scripts run without asking."
      >
        <Segmented value={s.shellConfirm} options={CONFIRM_OPTIONS} onChange={(shellConfirm) => setS({ ...s, shellConfirm })} />
        <div className="pref-hint">
          {s.shellConfirm === 'off'
            ? 'Commands run without asking.'
            : s.shellConfirm === 'destructive'
              ? 'Asks before drop(), dropDatabase(), dropIndexes(), renameCollection() and deletes or updates with an empty filter.'
              : 'Asks before every insert, update, delete, index change and drop.'}
        </div>
      </Field>

      <div className="section-title">History</div>
      <Field id="shellHistoryLimit" label="History size" hint="Commands kept for ↑ / ↓; older ones are dropped.">
        <IntInput value={s.shellHistoryLimit} min={SHELL_HISTORY_MIN} max={SHELL_HISTORY_MAX} step={100} onChange={(v) => setS({ ...s, shellHistoryLimit: v })} suffix="commands" />
      </Field>
      <Field id="shellHistoryDedupe" label="Duplicates">
        <Check checked={s.shellHistoryDedupe} onChange={(v) => setS({ ...s, shellHistoryDedupe: v })}>
          Don&apos;t store a command that repeats the previous one
        </Check>
      </Field>
      <Field id="shellHistoryScope" label="Keep history">
        <Segmented value={s.shellHistoryScope} options={[['connection', 'Per connection'], ['global', 'One for all shells']] as const} onChange={(shellHistoryScope) => setS({ ...s, shellHistoryScope })} />
      </Field>
      <Field id="shellHistoryClear" label="Stored">
        <div className="row">
          <span className="muted">
            {stored.toLocaleString()} command{stored === 1 ? '' : 's'}
          </span>
          <button
            className="btn small"
            disabled={!stored}
            onClick={async () => {
              if (!(await confirmDialog({ title: 'Clear shell history', message: 'Delete the command history of every shell (all connections)?', confirmLabel: 'Clear', danger: true }))) return
              clearShellHistory()
              setStored(shellHistoryCount())
              toast('Shell history cleared', 'success')
            }}
          >
            Clear history
          </button>
        </div>
      </Field>

      <div className="section-title">Time limits</div>
      <Field id="shellTimeoutMS" label="Shell commands" hint="Default of the time limit menu of new shell tabs. A command over the limit is stopped and the session restarts.">
        <SecondsInput ms={s.shellTimeoutMS} onChange={(shellTimeoutMS) => setS({ ...s, shellTimeoutMS })} />
      </Field>
      <Field id="playgroundTimeoutMS" label="Playground runs" hint="Default of the time limit menu of new playground tabs.">
        <SecondsInput ms={s.playgroundTimeoutMS} onChange={(playgroundTimeoutMS) => setS({ ...s, playgroundTimeoutMS })} />
      </Field>

      <div className="section-title">External mongosh</div>
      <MongoshField s={s} setS={setS} />
    </>
  )
}
