import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AppSettings, EditorArea, JsonStyle, ResultViewKind, ToolsStatus } from '@shared/api'
import { clampHistoryLimit, DEFAULT_SETTINGS, EDITOR_FONT_SIZES, HISTORY_LIMIT_MAX, HISTORY_LIMIT_MIN, UI_ZOOM_STEPS } from '@shared/settings'
import { JSON_STYLE_LABELS } from '@shared/docText'
import { api, modKey } from '../lib/api'
import { fontFamilyCss } from '../lib/uiPrefs'
import { highlightParts, hitsByTab, PREF_TABS, searchPrefs } from '@shared/prefSearch'
import type { PrefEntry, PrefTab } from '@shared/prefSearch'
import { errorText, saveSettings, toast, useStore } from '../state/store'
import { Modal, openModal } from './Modal'
import { Icon } from './Icon'
import { McpSettings } from './mcp/McpSettings'
import { AiSettings } from './ai/AiSettings'
import { ChangeHistorySettings } from './changes/ChangeHistorySettings'
import { NetworkSettings } from './network/NetworkSettings'
import { ValueColorsSettings } from './ValueColorsSettings'
import { DateSettings } from './DateSettings'
import { ShellSettings } from './shell/ShellSettings'
import { KeyboardSettings } from './keyboard/KeyboardSettings'
import { CollationForm } from './collation/CollationPicker'
import { collationLabel } from '@shared/collation'
import type { UpdateInfo } from '@shared/updates'
import fidwebLogo from '../assets/fidweb-logo.png'

type SetS = (s: AppSettings) => void

const FIDWEB_URL = 'https://fidweb.net'
const KOFI_URL = 'https://ko-fi.com/mexus'

/** Icon and one-line summary of each section (the side list). */
const SECTION_INFO: Record<PrefTab, { icon: string; blurb: string }> = {
  workspace: { icon: 'settings', blurb: 'Theme, zoom, colours, startup' },
  data: { icon: 'table', blurb: 'Collections, results, sorting' },
  editing: { icon: 'code', blurb: 'Font, indentation, suggestions' },
  shell: { icon: 'terminal', blurb: 'Shell output, history, Playground' },
  keyboard: { icon: 'key', blurb: 'Change the key of any command' },
  dates: { icon: 'history', blurb: 'Date format and time zones' },
  safety: { icon: 'shield', blurb: 'Confirmations and undo' },
  ai: { icon: 'sparkle', blurb: 'Assistant and MCP server' },
  network: { icon: 'plug', blurb: 'Proxy and Database Tools' },
  about: { icon: 'leaf', blurb: 'Version, author, support' }
}

/** The settings being edited, so a row can show "changed" and reset itself. */
const SettingsCtx = createContext<{ s: AppSettings; setS: SetS } | null>(null)

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * One setting: name and explanation on the left, the control on the right. `id` lets the search scroll to it;
 * when it is a settings key, a changed value is marked and can be reset to its default.
 */
function Field({ id, label, hint, top, children }: { id: string; label: ReactNode; hint?: ReactNode; top?: boolean; children: ReactNode }): ReactElement {
  const ctx = useContext(SettingsCtx)
  const key = id as keyof AppSettings
  const known = !!ctx && Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)
  const changed = known && !sameValue(ctx.s[key], DEFAULT_SETTINGS[key])
  return (
    <div className={`field pref-row ${top ? 'top' : ''} ${changed ? 'changed' : ''}`} data-pref={id}>
      <div className="pref-row-label">
        <label>
          {label}
          {changed && <span className="pref-dot" title="Changed from the default" />}
        </label>
        {hint && <div className="pref-hint">{hint}</div>}
        {changed && (
          <button className="link pref-reset" onClick={() => ctx.setS({ ...ctx.s, [key]: structuredClone(DEFAULT_SETTINGS[key]) })}>
            Reset to default
          </button>
        )}
      </div>
      <div className="pref-row-control">{children}</div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="pref-group">
      <h3 className="pref-group-title">{title}</h3>
      {children}
    </section>
  )
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }): ReactElement {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** On/off setting, shown as a switch. */
function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }): ReactElement {
  return (
    <label className="check">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children && <span>{children}</span>}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

function WorkspaceTab({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  return (
    <>
      <Group title="Look">
        <Field id="theme" label="Theme" hint="System follows the light or dark mode of the operating system.">
          <Segmented value={s.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] as const} onChange={(theme) => setS({ ...s, theme })} />
        </Field>
        <Field id="uiZoom" label="Interface zoom" hint={`Scales the whole window. ${modKey}+= / ${modKey}+- in the View menu change it until the next launch.`}>
          <select className="select" value={String(s.uiZoom)} onChange={(e) => setS({ ...s, uiZoom: Number(e.target.value) })}>
            {(UI_ZOOM_STEPS.includes(s.uiZoom) ? UI_ZOOM_STEPS : [...UI_ZOOM_STEPS, s.uiZoom].sort((a, b) => a - b)).map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)} %
              </option>
            ))}
          </select>
        </Field>
        <ValueColorsSettings s={s} setS={setS} />
      </Group>

      <Group title="When Shardwise starts">
        <Field id="restoreSession" label="Reopen the last tabs" hint="Ask shows a choice at launch.">
          <Segmented value={s.restoreSession} options={[['ask', 'Ask'], ['always', 'Always'], ['never', 'Never']] as const} onChange={(restoreSession) => setS({ ...s, restoreSession })} />
        </Field>
        <Field id="connectionManagerOnStart" label="Show the connection list" hint="At launch, when no tabs were reopened.">
          <Switch checked={s.connectionManagerOnStart} onChange={(v) => setS({ ...s, connectionManagerOnStart: v })} />
        </Field>
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------
// Browsing data
// ---------------------------------------------------------------------------

const PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000]
const VIEWS: [ResultViewKind, string][] = [
  ['table', 'Table'],
  ['tree', 'Tree'],
  ['json', 'JSON']
]
const JSON_SAMPLE: Record<JsonStyle, string> = {
  shell: "{ _id: ObjectId('65a1…'), qty: 3, at: ISODate('2026-01-05T10:00:00Z') }",
  relaxed: '{ "_id": { "$oid": "65a1…" }, "qty": 3, "at": { "$date": "2026-01-05T10:00:00Z" } }',
  canonical: '{ "_id": { "$oid": "65a1…" }, "qty": { "$numberInt": "3" }, "at": { "$date": { "$numberLong": "1767607200000" } } }'
}

function DataTab({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const [historyText, setHistoryText] = useState(String(s.historyLimit))
  return (
    <>
      <Group title="Opening a collection">
        <Field
          id="runQueryOnOpen"
          label="Load documents right away"
          hint={s.runQueryOnOpen ? 'The first page appears as soon as the tab opens.' : `New tabs wait with the default query filled in; press Run or ${modKey}+Enter. Also applies to restored tabs.`}
        >
          <Switch checked={s.runQueryOnOpen} onChange={(v) => setS({ ...s, runQueryOnOpen: v })} />
        </Field>
        <Field id="pageSize" label="Documents per page">
          <select className="select" value={s.pageSize} onChange={(e) => setS({ ...s, pageSize: Number(e.target.value) })}>
            {PAGE_SIZES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field id="defaultResultView" label="First view">
          <Segmented value={s.defaultResultView} options={VIEWS} onChange={(defaultResultView) => setS({ ...s, defaultResultView })} />
        </Field>
        <Field id="rememberResultView" label="Remember the view of each collection" hint="Reopens a collection in the view it was last shown in.">
          <Switch checked={s.rememberResultView} onChange={(v) => setS({ ...s, rememberResultView: v })} />
        </Field>
        <Field id="filterBuilderOnOpen" label="Show the Filter Builder" hint={`The panel can always be toggled per tab (${modKey}+B).`}>
          <Switch checked={s.filterBuilderOnOpen} onChange={(v) => setS({ ...s, filterBuilderOnOpen: v })} />
        </Field>
      </Group>

      <Group title="Running queries">
        <Field id="queryTimeoutMS" label="Time limit" hint="Milliseconds before the server stops a query; empty for no limit.">
          <input className="input" style={{ width: 140 }} value={s.queryTimeoutMS || ''} placeholder="no limit" onChange={(e) => setS({ ...s, queryTimeoutMS: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
        </Field>
        <Field id="autoCast" label="Match text to ObjectId and Date fields" hint={<>A 24-character hex string matches an ObjectId field, an ISO date string a Date field (e.g. <span className="mono">'650a…'</span>).</>}>
          <Switch checked={s.autoCast} onChange={(v) => setS({ ...s, autoCast: v })} />
        </Field>
        <Field id="historyLimit" label="Queries kept in history" hint={`${HISTORY_LIMIT_MIN.toLocaleString()}–${HISTORY_LIMIT_MAX.toLocaleString()}; older entries are removed when you lower it.`}>
          <input
            className="input"
            type="number"
            min={HISTORY_LIMIT_MIN}
            max={HISTORY_LIMIT_MAX}
            step={100}
            style={{ width: 120 }}
            value={historyText}
            onChange={(e) => {
              setHistoryText(e.target.value)
              setS({ ...s, historyLimit: clampHistoryLimit(e.target.value) })
            }}
            onBlur={() => setHistoryText(String(s.historyLimit))}
          />
        </Field>
      </Group>

      <Group title="Sorting and matching text">
        <Field
          id="defaultCollation"
          label="Language rules (collation)"
          top
          hint={
            s.defaultCollation
              ? `New query tabs start with ${collationLabel(s.defaultCollation)}. Strength 2 sorts and matches without regard to case. A connection can set its own (connection settings → Behavior).`
              : 'None: strings sort by code point (all capitals before lowercase, Ѝ and Ё after Я). Choose a language such as Bulgarian for dictionary order; strength 2 also ignores case.'
          }
        >
          <div className="coll-inline">
            <CollationForm value={s.defaultCollation} onChange={(defaultCollation) => setS({ ...s, defaultCollation })} />
          </div>
        </Field>
      </Group>

      <Group title="Showing documents">
        <Field id="treeExpandFirst" label="Open the first document in Tree view">
          <Switch checked={s.treeExpandFirst} onChange={(v) => setS({ ...s, treeExpandFirst: v })} />
        </Field>
        <Field id="jsonStyle" label="JSON format" top hint="JSON view, Copy Document and Copy results.">
          <Segmented value={s.jsonStyle} options={Object.entries(JSON_STYLE_LABELS) as [JsonStyle, string][]} onChange={(jsonStyle) => setS({ ...s, jsonStyle })} />
          <div className="pref-sample mono">{JSON_SAMPLE[s.jsonStyle]}</div>
        </Field>
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------
// Writing code
// ---------------------------------------------------------------------------

const MONO_FONTS = ['JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Fira Code', 'Source Code Pro', 'SF Mono', 'Menlo', 'Monaco', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New']
const AREAS: [EditorArea, string][] = [
  ['query', 'Query bar and filters'],
  ['pipeline', 'Pipeline stages'],
  ['shell', 'Shell'],
  ['sql', 'SQL'],
  ['playground', 'Playground']
]

function EditingTab({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const family = fontFamilyCss(s.editorFontFamily) ?? 'var(--mono)'
  return (
    <>
      <Group title="Text">
        <Field id="editorFontFamily" label="Font" hint="Any installed monospace font; empty uses the built-in one.">
          <input className="input mono" style={{ width: 300 }} list="pref-mono-fonts" value={s.editorFontFamily} placeholder="Default monospace font" onChange={(e) => setS({ ...s, editorFontFamily: e.target.value })} />
          <datalist id="pref-mono-fonts">
            {MONO_FONTS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field id="editorFontSize" label="Font size">
          <select className="select" value={s.editorFontSize} onChange={(e) => setS({ ...s, editorFontSize: Number(e.target.value) })}>
            <option value={0}>Default</option>
            {EDITOR_FONT_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
          <div className="cm-wrap pref-font-sample" style={{ fontFamily: family, fontSize: s.editorFontSize || 12 }}>
            {"db.orders.find({ status: 'paid', total: { $gte: 100 } })"}
          </div>
        </Field>
      </Group>

      <Group title="Typing">
        <Field id="editorTabWidth" label="Indentation" hint="Spaces per level.">
          <Segmented value={s.editorTabWidth} options={[[2, '2'], [3, '3'], [4, '4'], [8, '8']] as const} onChange={(editorTabWidth) => setS({ ...s, editorTabWidth })} />
        </Field>
        <Field id="editorCloseBrackets" label="Close brackets and quotes">
          <Switch checked={s.editorCloseBrackets} onChange={(v) => setS({ ...s, editorCloseBrackets: v })} />
        </Field>
        <Field id="editorLineWrapping" label="Wrap long lines" hint="JSON view, document editor, pipeline, SQL and Playground. One-line query fields always wrap.">
          <Switch checked={s.editorLineWrapping} onChange={(v) => setS({ ...s, editorLineWrapping: v })} />
        </Field>
        <Field id="editorAutocomplete" label="Suggestions while typing" top hint="When off, suggestions still open with Ctrl+Space.">
          <div className="pref-checks">
            {AREAS.map(([a, label]) => (
              <Switch key={a} checked={s.editorAutocomplete[a]} onChange={(v) => setS({ ...s, editorAutocomplete: { ...s.editorAutocomplete, [a]: v } })}>
                {label}
              </Switch>
            ))}
          </div>
        </Field>
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------
// Safety & undo
// ---------------------------------------------------------------------------

function SafetyTab({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  return (
    <>
      <Group title="Confirmations">
        <Field id="confirmSingleDelete" label="Ask before deleting one document" hint="Deleting several documents, dropping and bulk updates always ask.">
          <Switch checked={s.confirmSingleDelete} onChange={(v) => setS({ ...s, confirmSingleDelete: v })} />
        </Field>
      </Group>
      <Group title="Change History (undo)">
        <ChangeHistorySettings />
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------
// AI & automation, Network & tools
// ---------------------------------------------------------------------------

function AiTab(): ReactElement {
  return (
    <>
      <Group title="Assistant">
        <AiSettings />
      </Group>
      <Group title="MCP server">
        <McpSettings />
      </Group>
    </>
  )
}

function NetworkTab({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const [tools, setTools] = useState<ToolsStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    api.toolsStatus().then(setTools, () => setTools({ found: false }))
  }, [])
  return (
    <>
      <NetworkSettings s={s} setS={setS} />
      <Group title="MongoDB Database Tools">
        <Field
          id="toolsPath"
          label="Tools folder"
          hint={
            tools === null ? (
              'Checking for mongodump / mongorestore…'
            ) : tools.found ? (
              <>
                Found {tools.version ? `v${tools.version}` : ''} in <span className="mono">{tools.dir}</span>
              </>
            ) : (
              'mongodump / mongorestore not found: BSON export and import need them.'
            )
          }
        >
          <div className="row">
            <input className="input grow mono" value={s.toolsPath} placeholder="auto (PATH or downloaded)" onChange={(e) => setS({ ...s, toolsPath: e.target.value })} />
            <button
              className="btn"
              onClick={async () => {
                const r = await api.openFile({ directory: true, title: 'Folder containing mongodump and mongorestore' })
                if (r?.[0]) setS({ ...s, toolsPath: r[0] })
              }}
            >
              Browse…
            </button>
          </div>
          {tools && !tools.found && (
            <button
              className="btn small"
              style={{ marginTop: 8 }}
              disabled={downloading}
              onClick={async () => {
                setDownloading(true)
                try {
                  await api.downloadTools()
                  setTools(await api.toolsStatus())
                  toast('MongoDB Database Tools installed', 'success')
                } catch (e) {
                  toast(errorText(e), 'error')
                } finally {
                  setDownloading(false)
                }
              }}
            >
              {downloading ? 'Downloading…' : 'Download tools'}
            </button>
          )}
        </Field>
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutTab({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const [info, setInfo] = useState<{ version: string; electron: string; node: string } | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | 'checking' | null>(null)
  useEffect(() => {
    api.appInfo().then(setInfo, () => setInfo(null))
  }, [])
  const check = (): void => {
    setUpdate('checking')
    api.checkForUpdates().then(setUpdate, (e) => setUpdate({ status: 'error', current: info?.version ?? '', error: errorText(e) }))
  }
  return (
    <div className="about" data-pref="about">
      <div className="about-app">
        <span className="about-app-icon">
          <Icon name="leaf" size={30} />
        </span>
        <div>
          <div className="about-name">Shardwise {info?.version ?? ''}</div>
          <div className="faint about-sub">{info ? `Electron ${info.electron} · Node ${info.node}` : 'MongoDB GUI'}</div>
        </div>
      </div>

      <a className="about-card" href={FIDWEB_URL} target="_blank" rel="noreferrer" title={FIDWEB_URL}>
        <img src={fidwebLogo} alt="Fidweb" width={64} height={64} />
        <div>
          <div className="faint about-label">Made by</div>
          <div className="about-company">Fidweb</div>
          <div className="faint about-sub">Author: mexus · fidweb.net</div>
        </div>
        <Icon name="link" size={14} className="about-ext" />
      </a>

      <a className="about-card" href={KOFI_URL} target="_blank" rel="noreferrer" title={KOFI_URL}>
        <span className="about-kofi" aria-hidden>
          ☕
        </span>
        <div>
          <div className="about-company">Support Shardwise on Ko-fi</div>
          <div className="faint about-sub">ko-fi.com/mexus</div>
        </div>
        <Icon name="link" size={14} className="about-ext" />
      </a>

      <Group title="Updates">
        <Field id="checkUpdates" label="Check for updates when Shardwise starts" hint="Looks up the newest release on GitHub. Nothing is downloaded or installed without you.">
          <div className="row">
            <Switch checked={s.checkUpdates} onChange={(v) => setS({ ...s, checkUpdates: v })} />
            <button className="btn small" disabled={update === 'checking'} onClick={check}>
              {update === 'checking' ? 'Checking…' : 'Check now'}
            </button>
          </div>
          {update && update !== 'checking' && (
            <div className="pref-hint about-update">
              {update.status === 'available' ? (
                <a href={update.url} target="_blank" rel="noreferrer">
                  Shardwise {update.latest} is available — open the download page
                </a>
              ) : update.status === 'current' ? (
                `You have the latest version (${update.current}).`
              ) : update.status === 'unconfigured' ? (
                'Update checks start once the public repository is set (repository in package.json).'
              ) : (
                update.error
              )}
            </div>
          )}
        </Field>
      </Group>

      <div className="row about-actions">
        <button className="btn small" onClick={() => api.openThirdPartyNotices().catch((e) => toast(errorText(e), 'error'))}>
          Third-party notices
        </button>
      </div>
      <div className="faint about-legal">
        Independent software, not affiliated with or endorsed by MongoDB, Inc., 3T Software Labs or other vendors. MongoDB, Studio 3T and other names are
        trademarks of their respective owners and are mentioned only to describe compatibility.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function Highlighted({ text, query }: { text: string; query: string }): ReactElement {
  return <>{highlightParts(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>
}

function SearchResults({ results, query, onPick }: { results: PrefEntry[]; query: string; onPick: (e: PrefEntry) => void }): ReactElement {
  const tabName = new Map(PREF_TABS)
  if (!results.length) return <div className="result-empty" style={{ padding: 30 }}>No settings match "{query}".</div>
  return (
    <div className="pref-results">
      {results.map((r, i) => (
        <button key={`${r.tab}/${r.id}`} className={`pref-result ${i === 0 ? 'on' : ''}`} onClick={() => onPick(r)}>
          <span className="pref-result-tab">
            <Icon name={SECTION_INFO[r.tab].icon} size={12} /> {tabName.get(r.tab)}
          </span>
          <span>
            <Highlighted text={r.label} query={query} />
            {r.hint && <span className="faint"> — {r.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** Scroll to and flash the row of a search result once its section is shown. */
function flashField(body: HTMLElement | null, entry: PrefEntry): void {
  if (!body) return
  let el: HTMLElement | null = body.querySelector<HTMLElement>(`[data-pref="${CSS.escape(entry.id)}"]`)
  if (!el) {
    // Sections rendered by other components: find the row by its label text.
    const label = [...body.querySelectorAll<HTMLElement>('label')].find((l) => l.textContent?.trim() === entry.id)
    el = (label?.closest('.field, .chs-field') as HTMLElement | null) ?? label ?? null
  }
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  el.classList.remove('pref-flash')
  void el.offsetWidth
  el.classList.add('pref-flash')
  setTimeout(() => el?.classList.remove('pref-flash'), 1700)
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function Settings({ close, initialTab }: { close: () => void; initialTab?: PrefTab }): ReactElement {
  const current = useStore((st) => st.settings)
  const [s, setS] = useState<AppSettings>(current)
  const [tab, setTab] = useState<PrefTab>(initialTab ?? 'workspace')
  const [query, setQuery] = useState('')
  const [flash, setFlash] = useState<{ entry: PrefEntry; n: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => searchPrefs(query), [query])
  const hits = useMemo(() => hitsByTab(results), [results])
  const searching = query.trim().length > 0
  const pending = useMemo(() => (Object.keys(s) as (keyof AppSettings)[]).filter((k) => !sameValue(s[k], current[k])).length, [s, current])
  const ctx = useMemo(() => ({ s, setS }), [s])

  useEffect(() => {
    if (!flash) return
    // AI / MCP / Change History load their settings first; give them a moment to render.
    const t = setTimeout(() => flashField(bodyRef.current, flash.entry), 60)
    return () => clearTimeout(t)
  }, [flash])

  useEffect(() => {
    bodyRef.current?.querySelector('.pref-body')?.scrollTo({ top: 0 })
  }, [tab])

  const pick = (e: PrefEntry): void => {
    setQuery('')
    setTab(e.tab)
    setFlash((f) => ({ entry: e, n: (f?.n ?? 0) + 1 }))
  }

  const save = async (): Promise<void> => {
    try {
      await saveSettings(s)
      close()
    } catch (e) {
      toast(`Could not save the settings: ${errorText(e)}`, 'error')
    }
  }

  return (
    <Modal
      title={
        <div className="row pref-title">
          <span>Settings</span>
          <span className="spacer" />
          <input
            className="input pref-search"
            type="search"
            placeholder="Find a setting…"
            aria-label="Find a setting"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) pick(results[0])
            }}
          />
        </div>
      }
      icon="settings"
      onClose={close}
      width={960}
      footer={
        <>
          <span className="faint pref-pending">{pending ? `${pending} unsaved ${pending === 1 ? 'change' : 'changes'}` : 'No changes'}</span>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            {pending ? 'Discard' : 'Close'}
          </button>
          <button className="btn primary" disabled={!pending} onClick={save}>
            Save changes
          </button>
        </>
      }
    >
      <SettingsCtx.Provider value={ctx}>
        <div ref={bodyRef} className="pref-layout">
          <nav className={`pref-nav ${searching ? 'searching' : ''}`}>
            {PREF_TABS.map(([id, label]) => (
              <button
                key={id}
                className={`${tab === id && !searching ? 'on' : ''} ${hits[id] ? 'hit' : ''}`}
                onClick={() => {
                  setQuery('')
                  setTab(id)
                }}
              >
                <Icon name={SECTION_INFO[id].icon} size={15} />
                <span className="pref-nav-text">
                  <span className="pref-nav-label">
                    {label}
                    {searching && !!hits[id] && <span className="pref-hits">{hits[id]}</span>}
                  </span>
                  <span className="pref-nav-blurb">{SECTION_INFO[id].blurb}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="pref-body">
            {searching ? (
              <SearchResults results={results} query={query} onPick={pick} />
            ) : (
              <>
                <header className="pref-page-head">
                  <Icon name={SECTION_INFO[tab].icon} size={18} />
                  <div>
                    <h2>{new Map(PREF_TABS).get(tab)}</h2>
                    <div className="faint">{SECTION_INFO[tab].blurb}</div>
                  </div>
                </header>
                {tab === 'workspace' && <WorkspaceTab s={s} setS={setS} />}
                {tab === 'data' && <DataTab s={s} setS={setS} />}
                {tab === 'editing' && <EditingTab s={s} setS={setS} />}
                {tab === 'shell' && <ShellSettings s={s} setS={setS} />}
                {tab === 'keyboard' && <KeyboardSettings s={s} setS={setS} />}
                {tab === 'dates' && <DateSettings s={s} setS={setS} />}
                {tab === 'safety' && <SafetyTab s={s} setS={setS} />}
                {tab === 'ai' && <AiTab />}
                {tab === 'network' && <NetworkTab s={s} setS={setS} />}
                {tab === 'about' && <AboutTab s={s} setS={setS} />}
              </>
            )}
          </div>
        </div>
      </SettingsCtx.Provider>
    </Modal>
  )
}

export function openSettings(tab?: PrefTab): Promise<void> {
  return openModal<void>((close) => <Settings close={() => close()} initialTab={tab} />)
}
