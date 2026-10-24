import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { isPlainDoc, parseShellValue, shellText } from '@shared/bsonValue'
import { prefDocText } from '../../lib/docText'
import { collectPaths } from '@shared/docPaths'
import {
  AGG_EXPRESSION_OPERATORS,
  MAX_RESULT_DOCS,
  OUTPUT_STAGES,
  STAGE_OPERATORS,
  STAGE_TEMPLATES,
  StageError,
  hasOutputStage,
  keepIds,
  newStage,
  newStageId,
  pipelineDocs,
  pipelineText,
  previewPipeline,
  shellCommand,
  stageError,
  stagesFromFind,
  stagesFromText,
  templateFor
} from '@shared/pipeline'
import type { FindTexts, Stage } from '@shared/pipeline'
import type { AggregateOptions, AggregateResult, Doc } from '@shared/api'
import { pipelineKey, stagesFromDocs, viewPipelineError } from '@shared/viewEdit'
import { connName, dbKey, errorText, patchToolTab, refreshCollections, toast, useStore } from '../../state/store'
import type { ToolTab, ViewMode } from '../../state/store'
import { serverApi } from '../server/serverClient'
import { api } from '../../lib/api'
import { useCommandHandlers, useShortcut, withShortcuts } from '../../lib/commands'
import { CodeEditor } from '../CodeEditor'
import { confirmDialog, promptDialog } from '../Modal'
import { Icon } from '../Icon'
import { StageList } from './StageList'
import type { StageCount, StageListActions } from './StageList'
import { AggExplain, DocsView, ViewSwitch, docsTab } from './AggResults'
import { explainStageWithAi, generatePipelineDialog } from '../ai/AiActions'
import './aggregation.css'

interface Options {
  allowDiskUse: boolean
  maxTimeMS: string
  collation: string
  sampleSize: number
}

interface Preview {
  docs?: Doc[]
  error?: string
  note?: string
  loading?: boolean
}

interface RunState {
  docs?: Doc[]
  truncated?: boolean
  ms?: number
  error?: string
  running?: boolean
}

interface ExplainState {
  doc?: Doc
  error?: string
  loading?: boolean
}

const SAMPLE_SIZES = [5, 10, 20, 50, 100, 500, 1000]
const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // ignore
  }
}

/** Collation text passed by the opener (`init.collation`), if any. */
function initCollation(init: unknown): string {
  const v = (init as { collation?: unknown } | null | undefined)?.collation
  return typeof v === 'string' ? v.trim() : ''
}

/** View being edited (`init.view`), if any. */
function viewNameOf(init: unknown): string | undefined {
  const v = (init as { view?: unknown } | null | undefined)?.view
  return typeof v === 'string' && v ? v : undefined
}

function initialStages(init: unknown): { stages: Stage[]; error?: string } {
  const i = (init ?? {}) as { pipeline?: unknown; query?: FindTexts }
  // The view's stages arrive once its definition is loaded.
  if (viewNameOf(init)) return { stages: [] }
  if (typeof i.pipeline === 'string') {
    try {
      const s = stagesFromText(i.pipeline)
      return { stages: s.length ? s : [newStage('$match')] }
    } catch (e) {
      return { stages: [newStage('$match')], error: `Could not open the pipeline: ${errorText(e)}` }
    }
  }
  if (i.query) {
    const s = stagesFromFind(i.query)
    return { stages: s.length ? s : [newStage('$match')] }
  }
  return { stages: [newStage('$match')] }
}

/** Collection written by an $out / $merge stage. */
function outputTarget(stage: Doc): string {
  const [op, v] = Object.entries(stage)[0]
  if (typeof v === 'string') return v
  if (isPlainDoc(v)) {
    const t = op === '$out' ? v.coll : v.into
    if (typeof t === 'string') return t
    if (isPlainDoc(t)) return [t.db, t.coll].filter(Boolean).join('.')
  }
  return '?'
}

/** Server errors without the driver's 'Executor error … caused by ::' prefix. */
const serverError = (e: unknown): string => errorText(e).replace(/^Executor error during \w+ command on namespace: \S+ :: caused by :: /, '')

const docIds = new WeakMap<Doc[], number>()
let docSeq = 0
/** Stable key per result array, so the virtualised views remount when the documents change. */
function docsKey(docs: Doc[]): number {
  let k = docIds.get(docs)
  if (!k) docIds.set(docs, (k = ++docSeq))
  return k
}

const sameStage = (a: Stage | undefined, b: Stage | undefined): boolean =>
  !!a && !!b && a.id === b.id && a.op === b.op && a.body === b.body && a.enabled === b.enabled

function PreviewPane({ title, p, view, tabId, connId, db, hint }: { title: string; p: Preview; view: ViewMode; tabId: string; connId: string; db: string; hint: string }): ReactElement {
  const fake = useMemo(() => (p.docs ? docsTab(tabId, connId, db, p.docs, view) : null), [p.docs, view, tabId, connId, db])
  return (
    <div className="agg-preview">
      <div className="agg-preview-head" title={hint}>
        <span>{title}</span>
        {p.docs && !p.error && <span className="badge">{p.docs.length.toLocaleString()} docs</span>}
        {p.loading && <span className="agg-spinner" />}
      </div>
      <div className="agg-preview-body">
        {p.error ? (
          <div className="agg-preview-msg error selectable">{p.error}</div>
        ) : (
          <>
            {p.note && <div className="agg-preview-note">{p.note}</div>}
            {fake ? <DocsView key={docsKey(p.docs!)} tab={fake} /> : <div className="result-empty">{p.loading ? 'Loading preview…' : ''}</div>}
          </>
        )}
      </div>
    </div>
  )
}

export function AggregationView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const [viewName] = useState(() => viewNameOf(tab.init))
  /** Loaded view definition; `key` is the saved pipeline, for the dirty check. */
  const [viewDef, setViewDef] = useState<{ viewOn: string; key: string | null } | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [viewGen, setViewGen] = useState(0)
  // A view's previews and runs go to its source collection with the edited pipeline.
  const coll = viewName ? (viewDef?.viewOn ?? '') : (tab.coll ?? '')
  const ready = !viewName || !!viewDef
  const live = useStore((s) => s.live[connId])
  const isActive = useStore((s) => s.activeTab === tab.id)
  const [init] = useState(() => initialStages(tab.init))
  const [stages, setStages] = useState<Stage[]>(init.stages)
  const [selectedId, setSelectedId] = useState(init.stages[0]?.id ?? '')
  const [textMode, setTextMode] = useState(false)
  const [textSrc, setTextSrc] = useState('')
  const [textError, setTextError] = useState<string | null>(null)
  const [opts, setOpts] = useState<Options>(() => ({
    allowDiskUse: lsGet('agg.allowDiskUse') === '1',
    maxTimeMS: '',
    // A query tab opened here passes its collation along (`init.collation`).
    collation: initCollation(tab.init),
    sampleSize: Number(lsGet('agg.sampleSize')) || 20
  }))
  const [counts, setCounts] = useState<Record<string, StageCount>>({})
  const [input, setInput] = useState<Preview>({})
  const [output, setOutput] = useState<Preview>({})
  const [previewView, setPreviewView] = useState<ViewMode>(() => (lsGet('agg.previewView') as ViewMode) || 'tree')
  const [run, setRun] = useState<RunState>({})
  const [explain, setExplain] = useState<ExplainState>({})
  const [pane, setPane] = useState<'results' | 'explain'>('results')
  const [resultView, setResultView] = useState<ViewMode>('table')
  const [split, setSplit] = useState(() => Number(lsGet('agg.split')) || 0.62)
  const [dragging, setDragging] = useState(false)
  const [refreshGen, setRefreshGen] = useState(0)
  const splitBox = useRef<HTMLDivElement>(null)
  const previewSeq = useRef(0)
  const runSeq = useRef(0)
  const cache = useRef(new Map<string, Promise<AggregateResult>>())

  useEffect(() => {
    if (init.error) toast(init.error, 'error')
  }, [init.error])

  useEffect(() => {
    if (viewName) patchToolTab(tab.id, { title: `${viewName} · Edit View`, icon: 'view' })
  }, [viewName, tab.id])

  const connected = !!live
  useEffect(() => {
    if (!viewName || !connected) return
    let off = false
    serverApi.viewGet(connId, db, viewName).then(
      (def) => {
        if (off) return
        let st: Stage[]
        try {
          st = stagesFromDocs(def.pipeline)
        } catch (e) {
          setViewError(errorText(e))
          return
        }
        cache.current.clear()
        setCounts({})
        setStages(st)
        setSelectedId(st[0]?.id ?? '')
        setTextSrc(pipelineText(st, true))
        setTextError(null)
        setViewDef({ viewOn: def.viewOn, key: pipelineKey(st) })
        setViewError(null)
      },
      (e) => !off && setViewError(errorText(e))
    )
    return () => {
      off = true
    }
  }, [viewName, connected, connId, db, viewGen])

  const selIndex = stages.findIndex((s) => s.id === selectedId)
  const sel = selIndex >= 0 ? stages[selIndex] : undefined
  const errors = useMemo(() => {
    const out: Record<string, string> = {}
    for (const s of stages) {
      const e = stageError(s)
      if (e) out[s.id] = e
    }
    return out
  }, [stages])

  const collation = useMemo((): { value: Doc | null; error: string | null } => {
    if (!opts.collation.trim()) return { value: null, error: null }
    try {
      const v = parseShellValue(opts.collation)
      return isPlainDoc(v) ? { value: v, error: null } : { value: null, error: 'Collation must be an object' }
    } catch (e) {
      return { value: null, error: errorText(e) }
    }
  }, [opts.collation])

  const aggOpts = useCallback((): AggregateOptions => {
    const o: AggregateOptions = {}
    if (opts.allowDiskUse) o.allowDiskUse = true
    const ms = Number(opts.maxTimeMS)
    if (ms > 0) o.maxTimeMS = ms
    if (collation.value) o.collation = collation.value
    return o
  }, [opts.allowDiskUse, opts.maxTimeMS, collation.value])

  // ---- stage edits -------------------------------------------------------

  /** Replace the stages; counts from the first changed stage on are stale. */
  const update = (next: Stage[], fromText = false): void => {
    let from = 0
    while (from < next.length && sameStage(stages[from], next[from])) from++
    setCounts((c) => {
      const keep: Record<string, StageCount> = {}
      next.slice(0, from).forEach((s) => c[s.id] && (keep[s.id] = c[s.id]))
      return keep
    })
    setStages(next)
    if (textMode && !fromText) {
      setTextSrc(pipelineText(next, true))
      setTextError(null)
    }
    if (!next.some((s) => s.id === selectedId)) {
      const i = Math.min(Math.max(selIndex, 0), next.length - 1)
      setSelectedId(next[i]?.id ?? '')
    }
  }
  const patchStage = (id: string, p: Partial<Stage>): void => update(stages.map((s) => (s.id === id ? { ...s, ...p } : s)))

  const actions: StageListActions = {
    select: setSelectedId,
    setOp: (id, op) => {
      const s = stages.find((x) => x.id === id)
      if (!s || s.op === op) return
      const b = s.body.trim()
      const untouched = !b || b === '{}' || b === templateFor(s.op).trim()
      patchStage(id, { op, body: untouched ? templateFor(op) : s.body })
    },
    toggle: (id) => patchStage(id, { enabled: !stages.find((s) => s.id === id)?.enabled }),
    duplicate: (id) => {
      const i = stages.findIndex((s) => s.id === id)
      if (i < 0) return
      const copy = { ...stages[i], id: newStageId() }
      update([...stages.slice(0, i + 1), copy, ...stages.slice(i + 1)])
      setSelectedId(copy.id)
    },
    remove: (id) => update(stages.filter((s) => s.id !== id)),
    insert: (index, op) => {
      const s = newStage(op)
      update([...stages.slice(0, index), s, ...stages.slice(index)])
      setSelectedId(s.id)
    },
    move: (from, to) => {
      if (to < 0 || to >= stages.length) return
      const next = [...stages]
      const [s] = next.splice(from, 1)
      next.splice(to, 0, s)
      update(next)
    }
  }

  const setTextModeOn = (on: boolean): void => {
    if (on) setTextSrc(pipelineText(stages, true))
    setTextError(null)
    setTextMode(on)
  }

  const onText = (text: string): void => {
    setTextSrc(text)
    try {
      const parsed = keepIds(stages, stagesFromText(text))
      setTextError(null)
      update(parsed, true)
    } catch (e) {
      setTextError(errorText(e))
    }
  }

  // ---- previews -----------------------------------------------------------

  const optsKey = JSON.stringify([opts.allowDiskUse, opts.maxTimeMS, collation.value ? shellText(collation.value) : ''])
  const fetchDocs = useCallback(
    (pipeline: Doc[]): Promise<AggregateResult> => {
      const key = `${shellText(pipeline)}|${optsKey}`
      let p = cache.current.get(key)
      if (!p) {
        if (cache.current.size > 60) cache.current.clear()
        p = api.aggregate(connId, db, coll, pipeline, aggOpts())
        cache.current.set(key, p)
        p.catch(() => cache.current.delete(key))
      }
      return p
    },
    [connId, db, coll, aggOpts, optsKey]
  )

  const previewKey =
    selIndex < 0 || !live || !ready ? null : JSON.stringify([stages.slice(0, selIndex + 1).map((s) => [s.op, s.body, s.enabled]), opts.sampleSize, optsKey, refreshGen])

  useEffect(() => {
    if (previewKey === null) {
      setInput({})
      setOutput({})
      return
    }
    const my = ++previewSeq.current
    setInput((p) => ({ ...p, loading: true }))
    setOutput((p) => ({ ...p, loading: true }))
    const idx = selIndex
    const st = stages
    const n = opts.sampleSize
    const timer = setTimeout(() => {
      const current = (): boolean => my === previewSeq.current
      const count = (stage: Stage | undefined, docs: Doc[]): void => {
        if (stage) setCounts((c) => ({ ...c, [stage.id]: { n: docs.length, capped: docs.length >= n } }))
      }
      let prev: Stage | undefined
      for (let i = idx - 1; i >= 0; i--) {
        if (st[i].enabled && !OUTPUT_STAGES.has(st[i].op)) {
          prev = st[i]
          break
        }
      }
      let inPipe: Doc[] | null = null
      try {
        inPipe = previewPipeline(st, idx, n, 'input')
      } catch (e) {
        const se = e as StageError
        setInput({ error: `Fix stage ${se.index + 1} first. ${errorText(e)}` })
        setOutput({ error: `Fix stage ${se.index + 1} first.` })
        return
      }
      const inReq = fetchDocs(inPipe)
      inReq.then(
        (r) => {
          if (!current()) return
          setInput({ docs: r.docs })
          count(prev, r.docs)
        },
        (e) => current() && setInput({ error: serverError(e) })
      )
      const s = st[idx]
      if (!s.enabled || OUTPUT_STAGES.has(s.op)) {
        const note = !s.enabled ? 'This stage is disabled: documents pass through unchanged.' : `${s.op} writes to a collection and is not run in previews. Output shows the stage input.`
        inReq.then(
          (r) => current() && setOutput({ docs: r.docs, note }),
          (e) => current() && setOutput({ error: serverError(e) })
        )
        return
      }
      let outPipe: Doc[]
      try {
        outPipe = previewPipeline(st, idx, n, 'output')
      } catch (e) {
        setOutput({ error: errorText(e) })
        return
      }
      fetchDocs(outPipe).then(
        (r) => {
          if (!current()) return
          setOutput({ docs: r.docs })
          count(s, r.docs)
        },
        (e) => current() && setOutput({ error: serverError(e) })
      )
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  const refreshPreviews = (): void => {
    cache.current.clear()
    setRefreshGen((g) => g + 1)
  }

  const fields = useMemo(() => {
    const paths = collectPaths([...(input.docs ?? []), ...(textMode ? (output.docs ?? []) : [])].slice(0, 200))
    return [...paths, ...paths.filter((p) => !p.includes('.')).map((p) => `$${p}`), ...AGG_EXPRESSION_OPERATORS, ...STAGE_OPERATORS]
  }, [input.docs, output.docs, textMode])

  // ---- run / explain / tools ----------------------------------------------

  const enabledDocs = (): Doc[] | null => {
    try {
      return pipelineDocs(stages)
    } catch (e) {
      if (e instanceof StageError) setSelectedId(stages[e.index].id)
      toast(errorText(e), 'error')
      return null
    }
  }
  const checkOptions = (): boolean => {
    if (collation.error) toast(`Collation: ${collation.error}`, 'error')
    return !collation.error
  }

  const runPipeline = async (): Promise<void> => {
    if (!live) return toast('Not connected', 'error')
    if (!ready) return
    const docs = enabledDocs()
    if (!docs || !checkOptions()) return
    const out = docs.find((d) => OUTPUT_STAGES.has(Object.keys(d)[0]))
    if (out) {
      const op = Object.keys(out)[0]
      const ok = await confirmDialog({
        title: `Run pipeline with ${op}?`,
        message: (
          <>
            This pipeline writes its results to <b>{outputTarget(out)}</b>
            {op === '$out' ? ', replacing that collection if it exists.' : ', merging them into the existing documents.'} Continue?
          </>
        ),
        confirmLabel: 'Run and write',
        danger: true
      })
      if (!ok) return
    }
    const my = ++runSeq.current
    setPane('results')
    setRun((r) => ({ ...r, running: true, error: undefined }))
    try {
      const r = await api.aggregate(connId, db, coll, docs, aggOpts())
      if (my !== runSeq.current) return
      const truncated = r.docs.length > MAX_RESULT_DOCS
      const shown = truncated ? r.docs.slice(0, MAX_RESULT_DOCS) : r.docs
      setRun({ docs: shown, truncated, ms: r.ms })
      if (out) {
        toast(`Pipeline results written to ${outputTarget(out)}`, 'success')
        cache.current.clear()
        void refreshCollections(connId, db)
      }
      api
        .addHistory({
          configId: live.configId,
          connName: connName(connId),
          db,
          coll,
          payload: { kind: 'aggregate', pipeline: pipelineText(stages) },
          ms: r.ms,
          count: shown.length
        })
        .catch(() => {})
    } catch (e) {
      if (my === runSeq.current) setRun({ error: serverError(e) })
    }
  }

  const runExplain = async (): Promise<void> => {
    if (!live) return toast('Not connected', 'error')
    if (!ready) return
    const docs = enabledDocs()
    if (!docs || !checkOptions()) return
    setPane('explain')
    setExplain((x) => ({ ...x, loading: true, error: undefined }))
    try {
      // executionStats runs the pipeline; avoid that for pipelines that write.
      const verbosity = hasOutputStage(stages) ? 'queryPlanner' : 'executionStats'
      const doc = await api.explainAggregate(connId, db, coll, docs, aggOpts(), verbosity)
      setExplain({ doc })
    } catch (e) {
      setExplain({ error: serverError(e) })
    }
  }

  const copyShell = (): void => {
    const o = aggOpts()
    void api.copyText(shellCommand(coll, stages, { ...o })).then(() => toast('Shell code copied', 'success'))
  }

  const savePipeline = async (): Promise<void> => {
    const name = await promptDialog({
      title: 'Save Pipeline',
      label: 'Name',
      initial: `${coll} pipeline`,
      confirmLabel: 'Save',
      validate: (v) => (v.trim() ? null : 'Enter a name')
    })
    if (!name) return
    try {
      await api.saveQuery({ name: name.trim(), db, coll, configId: live?.configId, payload: { kind: 'aggregate', pipeline: pipelineText(stages, true) } })
      toast(`Saved “${name.trim()}”`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const viewDirty = !!viewDef && pipelineKey(stages) !== viewDef.key

  const saveView = async (): Promise<void> => {
    if (!live) return toast('Not connected', 'error')
    if (!viewName || !viewDef) return
    const docs = enabledDocs()
    if (!docs) return
    const bad = viewPipelineError(stages)
    if (bad) return toast(bad, 'error')
    const ok = await confirmDialog({
      title: 'Save View',
      message: (
        <>
          Replace the pipeline of view <b>{viewName}</b> with the {docs.length} enabled stage{docs.length === 1 ? '' : 's'} on <b>{viewDef.viewOn}</b>? Queries on the view
          use the new definition immediately{stages.length > docs.length ? '; disabled stages are not saved' : ''}.
        </>
      ),
      confirmLabel: 'Save view'
    })
    if (!ok) return
    try {
      await serverApi.viewUpdate(connId, db, viewName, viewDef.viewOn, docs)
      setViewDef({ ...viewDef, key: pipelineKey(stages) })
      toast(`View ${viewName} saved`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const revertView = async (): Promise<void> => {
    if (viewDirty && !(await confirmDialog({ title: 'Revert View', message: 'Discard your changes and reload the saved view definition?', confirmLabel: 'Revert', danger: true }))) return
    setViewGen((g) => g + 1)
  }

  const createView = async (): Promise<void> => {
    if (!live) return toast('Not connected', 'error')
    if (!ready) return
    const docs = enabledDocs()
    if (!docs) return
    const bad = viewPipelineError(stages)
    if (bad) return toast(bad, 'error')
    const existing = new Set((useStore.getState().collections[dbKey(connId, db)] ?? []).map((c) => c.name))
    const name = await promptDialog({
      title: viewName ? 'Save as New View' : 'Create View',
      label: `View on ${coll} using the ${docs.length} enabled stage${docs.length === 1 ? '' : 's'}`,
      initial: viewName ? `${viewName}_copy` : `${coll}_view`,
      confirmLabel: 'Create View',
      validate: (v) => {
        const n = v.trim()
        if (!n) return 'Enter a name'
        if (n.includes('$') || n.includes('\0')) return 'Names cannot contain $'
        if (existing.has(n)) return `${n} already exists in ${db}`
        return null
      }
    })
    if (!name) return
    try {
      await api.createView(connId, db, name.trim(), coll, docs)
      toast(`View ${name.trim()} created`, 'success')
      void refreshCollections(connId, db)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const generatePipeline = async (): Promise<void> => {
    const untouched = stages.length === 1 && stages[0].body.trim() === templateFor(stages[0].op).trim()
    const choice = await generatePipelineDialog({ connId, db, coll, current: pipelineText(stages, true), hasStages: stages.length > 0 && !untouched })
    if (!choice) return
    let parsed: Stage[]
    try {
      parsed = stagesFromText(choice.text)
    } catch (e) {
      return toast(`The generated pipeline could not be read: ${errorText(e)}`, 'error')
    }
    if (!parsed.length) return
    update(choice.mode === 'append' ? [...stages, ...parsed] : parsed)
    setSelectedId(parsed[0].id)
  }

  const copyResults = (): void => {
    if (!run.docs) return
    void api.copyText(prefDocText(run.docs)).then(() => toast(`${run.docs!.length.toLocaleString()} documents copied`, 'success'))
  }

  const latestRun = useRef(runPipeline)
  latestRun.current = runPipeline
  // Settings → Shortcuts → Pipeline editor (stage editors call it through their own submit keys).
  useCommandHandlers(isActive, { 'pipeline.run': () => void latestRun.current() })
  const runKey = useShortcut('pipeline.run')

  const startDrag = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const box = splitBox.current?.getBoundingClientRect()
    if (!box) return
    setDragging(true)
    let last = split
    const move = (ev: MouseEvent): void => {
      last = Math.min(0.88, Math.max(0.25, (ev.clientY - box.top) / box.height))
      setSplit(last)
    }
    const up = (): void => {
      setDragging(false)
      lsSet('agg.split', String(last))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const resultTab = useMemo(() => (run.docs ? docsTab(`${tab.id}:results`, connId, db, run.docs, resultView) : null), [run.docs, resultView, tab.id, connId, db])
  const enabledCount = stages.filter((s) => s.enabled).length
  const template = sel ? STAGE_TEMPLATES.find((t) => t.op === sel.op) : undefined
  const sampleHint = `Previews run the pipeline on the first ${opts.sampleSize} documents of ${coll} (a $limit is added before the first stage), so $group, $sort and $count results only reflect that sample.`

  return (
    <div className="agg">
      <div className="crumbs">
        <Icon name="server" size={13} style={{ color: live?.color ?? 'var(--leaf)' }} />
        <span>{connName(connId)}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="database" size={13} />
        <span>{db}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name={viewName ? 'view' : 'collection'} size={13} />
        <span>{viewName ?? coll}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="aggregate" size={13} />
        <b>{viewName ? 'Edit View' : 'Aggregation'}</b>
      </div>

      {viewName && (
        <div className={`agg-viewbar ${viewError ? 'error' : ''}`}>
          <Icon name={viewError ? 'warn' : 'view'} size={14} />
          {viewError ? (
            <span className="selectable ellipsis">
              Could not load view {viewName}: {viewError}
            </span>
          ) : viewDef ? (
            <span className="ellipsis">
              Editing view <code>{viewName}</code> (on <code>{viewDef.viewOn}</code>) · previews and runs use {viewDef.viewOn} with the edited pipeline
            </span>
          ) : (
            <span>Loading view {viewName}…</span>
          )}
          {viewDef && viewPipelineError(stages) && (
            <span className="agg-viewbar-warn" title={viewPipelineError(stages) ?? undefined}>
              <Icon name="warn" size={12} /> $out / $merge cannot be saved in a view
            </span>
          )}
          {viewDirty && (
            <span className="agg-viewbar-dirty">
              <i /> unsaved changes
            </span>
          )}
          <span className="spacer" />
          {(viewDef || viewError) && (
            <button className="btn ghost small" onClick={() => void revertView()} disabled={!!viewDef && !viewDirty} title="Reload the saved view definition">
              <Icon name="refresh" size={12} /> {viewError ? 'Retry' : 'Revert'}
            </button>
          )}
          <button className="btn small" onClick={() => void createView()} disabled={!live || !viewDef} title={`Create another view on ${coll} from the enabled stages`}>
            <Icon name="view" size={12} /> Save as new view…
          </button>
          <button className="btn primary small" onClick={() => void saveView()} disabled={!live || !viewDef || !viewDirty} title={`Save the enabled stages as the pipeline of ${viewName} (collMod)`}>
            <Icon name="check" size={12} /> Save view
          </button>
        </div>
      )}

      <div className="agg-toolbar">
        <button className="btn primary" onClick={() => void runPipeline()} disabled={!live || !ready || run.running} title={withShortcuts('Run the full pipeline', 'pipeline.run')}>
          <Icon name="play" size={12} /> Run
        </button>
        <button className="btn" onClick={() => void runExplain()} disabled={!live || !ready || explain.loading} title="Explain the pipeline (execution stats)">
          <Icon name="gauge" size={13} /> Explain
        </button>
        <span className="agg-sep" />
        <label className="check agg-opt" title="Let blocking stages ($sort, $group) write temporary files">
          <input
            type="checkbox"
            checked={opts.allowDiskUse}
            onChange={(e) => {
              setOpts({ ...opts, allowDiskUse: e.target.checked })
              lsSet('agg.allowDiskUse', e.target.checked ? '1' : '0')
            }}
          />
          Allow disk use
        </label>
        <label className="agg-opt" title="maxTimeMS: abort the pipeline after this many milliseconds (empty = settings default)">
          Max time
          <input
            className="input small agg-num"
            value={opts.maxTimeMS}
            placeholder="default"
            onChange={(e) => setOpts({ ...opts, maxTimeMS: e.target.value.replace(/\D/g, '') })}
          />
          ms
        </label>
        <label className="agg-opt" title="Collation, e.g. { locale: 'en', strength: 2 }">
          Collation
          <input
            className={`input small mono agg-collation ${collation.error ? 'invalid' : ''}`}
            value={opts.collation}
            placeholder="{ locale: 'en' }"
            title={collation.error ?? undefined}
            onChange={(e) => setOpts({ ...opts, collation: e.target.value })}
          />
        </label>
        <label className="agg-opt" title={sampleHint}>
          Preview
          <select
            className="select small"
            value={opts.sampleSize}
            onChange={(e) => {
              setOpts({ ...opts, sampleSize: Number(e.target.value) })
              lsSet('agg.sampleSize', e.target.value)
            }}
          >
            {SAMPLE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} docs
              </option>
            ))}
          </select>
        </label>
        <span className="agg-sep" />
        <button className={`btn small ${textMode ? 'active' : ''}`} onClick={() => setTextModeOn(!textMode)} title="Edit the whole pipeline as shell-syntax text">
          <Icon name="code" size={13} /> Pipeline as text
        </button>
        <button className="btn small" onClick={() => void generatePipeline()} disabled={!live} title="Describe the result and let Claude write the stages">
          <Icon name="sparkle" size={13} /> Generate pipeline…
        </button>
        <span className="spacer" />
        <button className="btn ghost small" onClick={copyShell} title="Copy db.getCollection(…).aggregate([…]) to the clipboard">
          <Icon name="copy" size={13} /> Copy code
        </button>
        <button className="btn ghost small" onClick={() => void savePipeline()} title="Save the pipeline to the Query Library">
          <Icon name="bookmark" size={13} /> Save…
        </button>
        {!viewName && (
          <button className="btn ghost small" onClick={() => void createView()} disabled={!live} title="Create a view from the enabled stages">
            <Icon name="view" size={13} /> Create view…
          </button>
        )}
      </div>

      <div className={`agg-split ${dragging ? 'dragging' : ''}`} ref={splitBox}>
        <div className="agg-top" style={{ height: `${split * 100}%` }}>
          <div className="agg-left">
            <div className="agg-left-head">
              <b>Pipeline</b>
              <span className="badge">
                {enabledCount === stages.length ? `${stages.length} stage${stages.length === 1 ? '' : 's'}` : `${enabledCount} of ${stages.length} enabled`}
              </span>
            </div>
            <StageList stages={stages} selectedId={selectedId} errors={errors} counts={counts} sampleSize={opts.sampleSize} actions={actions} />
          </div>
          <div className="agg-center">
            {textMode ? (
              <div className="agg-editor text">
                <div className="agg-editor-head">
                  <b>Pipeline as text</b>
                  <span className="faint ellipsis">
                    Shell syntax; stages marked <code>/* disabled */</code> are skipped. Edits update the stage list.
                  </span>
                </div>
                <CodeEditor value={textSrc} onChange={onText} onSubmit={() => void runPipeline()} submitCommand="pipeline.run" fields={fields} full area="pipeline" invalid={!!textError} className="agg-code" />
                {textError && <div className="agg-error selectable">{textError} — the stage list keeps the last valid pipeline.</div>}
              </div>
            ) : sel ? (
              <div className="agg-editor">
                <div className="agg-editor-head">
                  <b>Stage {selIndex + 1}</b>
                  <code className="agg-op-name">{sel.op}</code>
                  {template && <span className="faint ellipsis">{template.info}</span>}
                  <span className="spacer" />
                  <label className="check small-text" title="Disabled stages are skipped">
                    <input type="checkbox" checked={sel.enabled} onChange={() => actions.toggle(sel.id)} /> Enabled
                  </label>
                  <button
                    className="btn ghost small"
                    title="Ask the AI to explain this stage"
                    disabled={!live}
                    onClick={() => void explainStageWithAi({ connId, db, coll, pipeline: pipelineText(stages, true), index: selIndex, op: sel.op })}
                  >
                    <Icon name="sparkle" size={12} /> Explain stage
                  </button>
                  <button className="btn ghost small" title="Replace the body with the operator template" onClick={() => patchStage(sel.id, { body: templateFor(sel.op) })}>
                    <Icon name="refresh" size={12} /> Template
                  </button>
                </div>
                <CodeEditor
                  key={sel.id}
                  value={sel.body}
                  onChange={(body) => patchStage(sel.id, { body })}
                  onSubmit={() => void runPipeline()}
                  submitCommand="pipeline.run"
                  fields={fields}
                  full
                  area="pipeline"
                  invalid={!!errors[sel.id]}
                  className="agg-code"
                  placeholder={`${sel.op} body, e.g. ${templateFor(sel.op).replace(/\s+/g, ' ')}`}
                />
                {errors[sel.id] && <div className="agg-error selectable">{errors[sel.id]}</div>}
              </div>
            ) : (
              <div className="agg-editor">
                <div className="result-empty">The pipeline is empty. Add a stage to start.</div>
              </div>
            )}
            <div className="agg-preview-bar">
              <Icon name="view" size={13} />
              <span className="ellipsis" title={sampleHint}>
                {sel ? (
                  <>
                    Stage {selIndex + 1} preview on a sample of <b>{opts.sampleSize}</b> documents
                  </>
                ) : (
                  'Stage preview'
                )}
              </span>
              <span className="spacer" />
              <ViewSwitch
                value={previewView}
                views={[
                  ['tree', 'Tree', 'tree'],
                  ['json', 'JSON', 'json'],
                  ['table', 'Table', 'table']
                ]}
                onChange={(v) => {
                  setPreviewView(v)
                  lsSet('agg.previewView', v)
                }}
              />
              <button className="btn ghost icon small" title="Refresh previews" onClick={refreshPreviews} disabled={!sel}>
                <Icon name="refresh" size={13} />
              </button>
            </div>
            <div className="agg-previews">
              <PreviewPane title="Stage input" p={input} view={previewView} tabId={`${tab.id}:in`} connId={connId} db={db} hint={sampleHint} />
              <PreviewPane title="Stage output" p={output} view={previewView} tabId={`${tab.id}:out`} connId={connId} db={db} hint={sampleHint} />
            </div>
          </div>
        </div>
        <div className="agg-resizer" onMouseDown={startDrag} title="Drag to resize" />
        <div className="agg-results">
          <div className="result-toolbar agg-results-bar">
            <div className="agg-tabs">
              <button className={pane === 'results' ? 'on' : ''} onClick={() => setPane('results')}>
                Results
                {run.docs && (
                  <span className="agg-tab-count">
                    {run.truncated ? `first ${MAX_RESULT_DOCS.toLocaleString()}` : run.docs.length.toLocaleString()}
                  </span>
                )}
                {run.error && <span className="agg-tab-count bad">error</span>}
              </button>
              <button className={pane === 'explain' ? 'on' : ''} onClick={() => setPane('explain')}>
                Explain
                {explain.error && <span className="agg-tab-count bad">error</span>}
              </button>
            </div>
            <span className="spacer" />
            {pane === 'results' && run.docs && (
              <>
                {run.ms !== undefined && <span className="faint">{run.ms.toLocaleString()} ms</span>}
                <ViewSwitch value={resultView} onChange={setResultView} />
                <button className="btn ghost small" onClick={copyResults} title="Copy the results as shell JSON" disabled={!run.docs.length}>
                  <Icon name="copy" size={13} /> Copy JSON
                </button>
              </>
            )}
          </div>
          <div className="result-area">
            {((pane === 'results' && run.running) || (pane === 'explain' && explain.loading)) && <div className="loading-bar" />}
            {pane === 'results' ? (
              run.error ? (
                <div className="notice error selectable agg-run-error">{run.error}</div>
              ) : resultTab ? (
                <>
                  {run.truncated && (
                    <div className="agg-truncated">
                      <Icon name="warn" size={13} /> Showing the first {MAX_RESULT_DOCS.toLocaleString()} documents. Add a $limit stage or write the results with $out to get all of
                      them.
                    </div>
                  )}
                  <DocsView key={docsKey(run.docs!)} tab={resultTab} />
                </>
              ) : (
                <div className="result-empty">
                  {run.running ? (
                    'Running pipeline…'
                  ) : (
                    <>
                      Press {runKey ? <span className="kbd">{runKey}</span> : 'Run'} to run the full pipeline ({enabledCount} enabled stage{enabledCount === 1 ? '' : 's'}).
                    </>
                  )}
                </div>
              )
            ) : explain.error ? (
              <div className="notice error selectable agg-run-error">{explain.error}</div>
            ) : explain.doc ? (
              <AggExplain doc={explain.doc} />
            ) : (
              <div className="result-empty">{explain.loading ? 'Explaining pipeline…' : 'Click Explain to see how MongoDB executes the pipeline.'}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
