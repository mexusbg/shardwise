import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { AiSuggestion } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, openAggregationTab, patchTab } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { runQuery, syncTextToVqb } from '../../state/queryActions'
import { openSettings } from '../SettingsDialog'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { aiApi } from './aiClient'

const EXAMPLES = ['VIP customers from Rome sorted by age', 'orders over 100 created last month', 'count orders per status with total revenue']

function AskBody({ tab, close }: { tab: QueryTab; close: () => void }): ReactElement {
  const [prompt, setPrompt] = useState('')
  const [samples, setSamples] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AiSuggestion | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    api.aiStatus().then((s) => setConfigured(s.configured), () => setConfigured(false))
    aiApi.aiGetSettings().then((s) => setSamples(s.sendSamples), () => {})
  }, [])

  const ask = async (): Promise<void> => {
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api.aiSuggest({
          connId: tab.connId,
          db: tab.db,
          coll: tab.coll,
          prompt,
          includeSamples: samples,
          current: { query: tab.queryText, projection: tab.projectionText, sort: tab.sortText }
        })
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const apply = (): void => {
    if (!result) return
    if (result.kind === 'aggregate') {
      openAggregationTab(tab.connId, tab.db, tab.coll, { pipeline: result.pipeline })
    } else {
      patchTab(tab.id, { queryText: result.query, projectionText: result.projection, sortText: result.sort, limitText: result.limit.replace(/\D/g, ''), error: undefined })
      syncTextToVqb(tab.id, 'query')
      syncTextToVqb(tab.id, 'projection')
      syncTextToVqb(tab.id, 'sort')
      void runQuery(tab.id)
    }
    close()
  }

  const preview = result
    ? result.kind === 'aggregate'
      ? result.pipeline
      : [`query:      ${result.query || '{}'}`, result.projection && `projection: ${result.projection}`, result.sort && `sort:       ${result.sort}`, result.limit && `limit:      ${result.limit}`]
          .filter(Boolean)
          .join('\n')
    : ''

  return (
    <Modal
      title={`Ask AI — ${tab.db}.${tab.coll}`}
      icon="sparkle"
      onClose={close}
      width={680}
      footer={
        <>
          <span className="muted grow" style={{ fontSize: 12 }}>
            Sends field names and types{samples ? ' and 3 sample documents' : ''} to the AI provider. Nothing runs until you apply it.
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          {result ? (
            <button className="btn primary" onClick={apply}>
              {result.kind === 'aggregate' ? 'Open in Pipeline Editor' : 'Apply & run'}
            </button>
          ) : (
            <button className="btn primary" onClick={ask} disabled={busy || !prompt.trim() || !configured}>
              {busy ? 'Thinking…' : 'Generate'}
            </button>
          )}
        </>
      }
    >
      {configured === false && (
        <div className="notice" style={{ marginBottom: 10 }}>
          Set up an AI provider (Claude or an OpenAI-compatible service) to use the AI helper.{' '}
          <button
            className="link"
            onClick={() => {
              close()
              void openSettings('ai')
            }}
          >
            Open Settings
          </button>
        </div>
      )}
      <textarea
        className="input"
        style={{ width: '100%' }}
        rows={3}
        autoFocus
        placeholder="Describe the documents you want, e.g. “customers in Rome who signed up this year, newest first”"
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value)
          setResult(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask()
        }}
      />
      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        {EXAMPLES.map((x) => (
          <button key={x} className="btn small ghost" onClick={() => setPrompt(x)}>
            {x}
          </button>
        ))}
        <span className="spacer" />
        <label className="check" title="Helps with value formats; sends real data to the API">
          <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} /> Include 3 sample documents
        </label>
      </div>
      {error && (
        <div className="notice error selectable" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="badge">{result.kind === 'aggregate' ? 'Aggregation pipeline' : 'Find query'}</span>
            <span className="muted">{result.explanation}</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => setResult(null)}>
              <Icon name="refresh" size={12} /> Try again
            </button>
          </div>
          <CodeEditor value={preview} readOnly full minHeight={80} maxHeight={260} />
        </div>
      )}
    </Modal>
  )
}

export function openAskAi(tab: QueryTab): Promise<void> {
  return openModal<void>((close) => <AskBody tab={tab} close={() => close()} />)
}
