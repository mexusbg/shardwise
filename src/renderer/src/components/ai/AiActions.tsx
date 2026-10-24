import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { shellText } from '@shared/bsonValue'
import type { AiCodeResult, AiFixResult, AiPipelineResult, AiQueryTexts, AiText } from '@shared/aiApi'
import type { Doc, PlaygroundLanguage } from '@shared/api'
import { errorText, patchTab } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { runQuery, syncTextToVqb } from '../../state/queryActions'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { openSettings } from '../SettingsDialog'
import { aiApi } from './aiClient'
import { CopyButton, Markdown } from './Markdown'
import './ai.css'

const texts = (t: QueryTab): AiQueryTexts => ({ query: t.queryText, projection: t.projectionText, sort: t.sortText, skip: t.skipText, limit: t.limitText })

function queryLine(q: AiQueryTexts): string {
  let s = `find(${q.query.trim() || '{}'})`
  if (q.projection.trim()) s += `.projection(${q.projection.trim()})`
  if (q.sort.trim()) s += `.sort(${q.sort.trim()})`
  if (q.skip.trim()) s += `.skip(${q.skip.trim()})`
  if (q.limit.trim()) s += `.limit(${q.limit.trim()})`
  return s.replace(/\s*\n\s*/g, ' ')
}

function Working({ label = 'Asking the AI…' }: { label?: string }): ReactElement {
  return (
    <div className="ai-working">
      <span className="ai-spinner" /> {label}
    </div>
  )
}

function AiError({ error, onRetry, close }: { error: string; onRetry?: () => void; close: () => void }): ReactElement {
  const keyProblem = /api key/i.test(error)
  return (
    <div className="notice error selectable">
      {error}{' '}
      {keyProblem ? (
        <button
          className="link"
          onClick={() => {
            close()
            void openSettings('ai')
          }}
        >
          Open Settings
        </button>
      ) : (
        onRetry && (
          <button className="link" onClick={onRetry}>
            Try again
          </button>
        )
      )}
    </div>
  )
}

/** Runs `task` once on mount (and on retry); keeps the latest result. */
function useTask<T>(task: () => Promise<T>, auto = true): { result: T | null; error: string | null; busy: boolean; run: () => void } {
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const latest = useRef(task)
  latest.current = task
  const run = (): void => {
    const my = ++seq.current
    setBusy(true)
    setError(null)
    setResult(null)
    latest.current().then(
      (r) => my === seq.current && setResult(r),
      (e) => my === seq.current && setError(errorText(e))
    ).finally(() => my === seq.current && setBusy(false))
  }
  useEffect(() => {
    if (auto) run()
    return () => {
      seq.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { result, error, busy, run }
}

// ---------------------------------------------------------------------------
// Text answers: explain query / plan / stage
// ---------------------------------------------------------------------------

function TextAnswer({ title, context, task, close }: { title: string; context: ReactNode; task: () => Promise<AiText>; close: () => void }): ReactElement {
  const t = useTask(task)
  return (
    <Modal
      title={title}
      icon="sparkle"
      onClose={close}
      width={720}
      footer={
        <>
          <span className="faint grow ai-foot-note">AI answers can be wrong — check before acting on them.</span>
          {t.result && <CopyButton text={t.result.text} label="Copy answer" />}
          {t.result && (
            <button className="btn" onClick={t.run}>
              <Icon name="refresh" size={12} /> Regenerate
            </button>
          )}
          <button className="btn primary" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="ai-modal">
        {context}
        {t.busy && <Working />}
        {t.error && <AiError error={t.error} onRetry={t.run} close={close} />}
        {t.result && (
          <div className="ai-result">
            <Markdown text={t.result.text} />
          </div>
        )}
      </div>
    </Modal>
  )
}

function Context({ label, code }: { label: string; code: string }): ReactElement {
  return (
    <div className="ai-context">
      <span>{label}</span>
      <code title={code}>{code}</code>
    </div>
  )
}

export function explainQueryWithAi(tab: QueryTab): Promise<void> {
  const q = texts(tab)
  // Reuse the explain the tab already ran, when it is for the current query.
  const ex = tab.explain
  const explain = ex?.result && !ex.loading && ex.query && tab.applied && shellText(ex.query) === shellText(tab.applied) ? ex.result : undefined
  return openModal<void>((close) => (
    <TextAnswer
      title={`Explain with AI — ${tab.db}.${tab.coll}`}
      context={<Context label="Query" code={queryLine(q)} />}
      task={() => aiApi.aiExplainQuery({ connId: tab.connId, db: tab.db, coll: tab.coll, query: q, explain })}
      close={() => close()}
    />
  ))
}

export function explainPlanWithAi(o: { connId: string; db: string; coll: string; explain: Doc; label?: string }): Promise<void> {
  return openModal<void>((close) => (
    <TextAnswer
      title={`Explain plan with AI — ${o.db}.${o.coll}`}
      context={o.label ? <Context label="Query" code={o.label} /> : null}
      task={() => aiApi.aiExplainPlan(o)}
      close={() => close()}
    />
  ))
}

export function explainStageWithAi(o: { connId: string; db: string; coll: string; pipeline: string; index: number; op: string }): Promise<void> {
  return openModal<void>((close) => (
    <TextAnswer
      title={`Explain stage ${o.index + 1} — ${o.op}`}
      context={<Context label={`${o.db}.${o.coll}`} code={`stage ${o.index + 1}: ${o.op}`} />}
      task={() => aiApi.aiExplainStage({ connId: o.connId, db: o.db, coll: o.coll, pipeline: o.pipeline, index: o.index })}
      close={() => close()}
    />
  ))
}

// ---------------------------------------------------------------------------
// Fix with AI
// ---------------------------------------------------------------------------

function FixBody({ tab, close }: { tab: QueryTab; close: () => void }): ReactElement {
  const err = tab.error!
  const t = useTask<AiFixResult>(() => aiApi.aiFixQuery({ connId: tab.connId, db: tab.db, coll: tab.coll, query: texts(tab), error: { part: err.part, message: err.message } }))
  const r = t.result
  const preview = r
    ? [`query:      ${r.query || '{}'}`, r.projection && `projection: ${r.projection}`, r.sort && `sort:       ${r.sort}`, r.limit && `limit:      ${r.limit}`].filter(Boolean).join('\n')
    : ''
  const apply = (): void => {
    if (!r) return
    patchTab(tab.id, { queryText: r.query, projectionText: r.projection, sortText: r.sort, limitText: r.limit.replace(/\D/g, '') || tab.limitText, error: undefined })
    syncTextToVqb(tab.id, 'query')
    syncTextToVqb(tab.id, 'projection')
    syncTextToVqb(tab.id, 'sort')
    void runQuery(tab.id)
    close()
  }
  return (
    <Modal
      title={`Fix with AI — ${tab.db}.${tab.coll}`}
      icon="sparkle"
      onClose={close}
      width={680}
      footer={
        <>
          <span className="faint grow ai-foot-note">Nothing runs until you apply it.</span>
          {r && <CopyButton text={preview} />}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={apply} disabled={!r}>
            Apply &amp; run
          </button>
        </>
      }
    >
      <div className="ai-modal">
        <div className="notice error selectable" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
          {err.part}: {err.message}
        </div>
        {t.busy && <Working label="Looking for the problem…" />}
        {t.error && <AiError error={t.error} onRetry={t.run} close={close} />}
        {r && (
          <>
            <div className="ai-explanation">
              <Icon name="sparkle" size={13} />
              <span className="selectable">{r.explanation}</span>
            </div>
            <CodeEditor value={preview} readOnly full minHeight={60} maxHeight={260} />
          </>
        )}
      </div>
    </Modal>
  )
}

export function fixQueryWithAi(tab: QueryTab): Promise<void> {
  if (!tab.error) return Promise.resolve()
  return openModal<void>((close) => <FixBody tab={tab} close={() => close()} />)
}

// ---------------------------------------------------------------------------
// Generate (pipeline / code): prompt → preview → apply
// ---------------------------------------------------------------------------

interface GenerateProps<R> {
  title: string
  placeholder: string
  examples: string[]
  note: string
  generate: (prompt: string) => Promise<R>
  preview: (r: R) => { code: string; explanation: string }
  actions: (r: R) => ReactNode
  close: () => void
}

function GenerateBody<R>(p: GenerateProps<R>): ReactElement {
  const [prompt, setPrompt] = useState('')
  const t = useTask<R>(() => p.generate(prompt.trim()), false)
  const go = (): void => {
    if (prompt.trim() && !t.busy) t.run()
  }
  const view = t.result ? p.preview(t.result) : null
  return (
    <Modal
      title={p.title}
      icon="sparkle"
      onClose={p.close}
      width={720}
      footer={
        <>
          <span className="faint grow ai-foot-note">{p.note}</span>
          {view && <CopyButton text={view.code} />}
          <button className="btn" onClick={p.close}>
            Cancel
          </button>
          {t.result ? (
            p.actions(t.result)
          ) : (
            <button className="btn primary" onClick={go} disabled={t.busy || !prompt.trim()}>
              {t.busy ? 'Generating…' : 'Generate'}
            </button>
          )}
        </>
      }
    >
      <div className="ai-modal">
        <textarea
          className="input"
          style={{ width: '100%' }}
          rows={3}
          autoFocus
          placeholder={p.placeholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              go()
            }
          }}
        />
        {!t.result && !t.busy && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {p.examples.map((x) => (
              <button key={x} className="btn small ghost" onClick={() => setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        {t.busy && <Working />}
        {t.error && <AiError error={t.error} onRetry={go} close={p.close} />}
        {view && (
          <>
            <div className="ai-explanation">
              <Icon name="sparkle" size={13} />
              <span className="selectable grow">{view.explanation}</span>
              <button className="btn small ghost" onClick={go} title="Generate again">
                <Icon name="refresh" size={12} /> Retry
              </button>
            </div>
            <CodeEditor value={view.code} readOnly full minHeight={80} maxHeight={320} />
          </>
        )}
      </div>
    </Modal>
  )
}

export type PipelineChoice = { text: string; mode: 'replace' | 'append' }

/** "Generate pipeline…": resolves with the new stages' text and whether to replace or append, or null. */
export function generatePipelineDialog(o: { connId: string; db: string; coll: string; current: string; hasStages: boolean }): Promise<PipelineChoice | null> {
  return openModal<PipelineChoice | null>((close) => (
    <GenerateBody<AiPipelineResult>
      title={`Generate pipeline — ${o.db}.${o.coll}`}
      placeholder="Describe the result you want, e.g. “revenue per month for paid orders, newest month first”"
      examples={['count documents per status', 'top 5 customers by total amount', 'join each order with its customer']}
      note="Sends field names and types (and sample values if enabled in Settings). Nothing runs automatically."
      generate={(prompt) => aiApi.aiGeneratePipeline({ connId: o.connId, db: o.db, coll: o.coll, prompt, current: o.hasStages ? o.current : '' })}
      preview={(r) => ({ code: r.pipeline, explanation: r.explanation })}
      actions={(r) =>
        o.hasStages ? (
          <>
            <button className="btn" onClick={() => close({ text: r.pipeline, mode: 'append' })} title="Add the generated stages after the current ones">
              Append stages
            </button>
            <button className="btn primary" onClick={() => close({ text: r.pipeline, mode: 'replace' })} title="Replace the whole pipeline">
              Replace pipeline
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => close({ text: r.pipeline, mode: 'replace' })}>
            Use pipeline
          </button>
        )
      }
      close={() => close(null)}
    />
  ))
}

/** "Generate code…": resolves with code to insert (never run), or null. */
export function generateCodeDialog(o: { connId: string; db: string; language: PlaygroundLanguage; code: string; selection: string }): Promise<string | null> {
  return openModal<string | null>((close) => (
    <GenerateBody<AiCodeResult>
      title={`Generate code — ${o.db}`}
      placeholder="Describe what the script should do, e.g. “for each collection print its document count”"
      examples={['print the 5 largest collections by document count', 'find duplicate emails in users', 'average order amount per month this year']}
      note="The code is inserted into the editor; it does not run until you press Run."
      generate={(prompt) => aiApi.aiGenerateCode({ connId: o.connId, db: o.db, prompt, language: o.language, code: o.code, selection: o.selection })}
      preview={(r) => ({ code: r.code, explanation: r.explanation })}
      actions={(r) => (
        <button className="btn primary" onClick={() => close(r.code)}>
          {o.selection ? 'Replace selection' : 'Insert at cursor'}
        </button>
      )}
      close={() => close(null)}
    />
  ))
}

