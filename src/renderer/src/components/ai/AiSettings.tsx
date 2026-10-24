import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { AI_MODELS, COMPATIBLE_SERVICES, isLocalAiUrl } from '@shared/aiApi'
import type { AiEffort, AiProvider, AiSettings as Settings, AiStatus, AiTestResult, AiUsage } from '@shared/aiApi'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import { aiApi } from './aiClient'
import './ai.css'

const EFFORTS: [AiEffort, string][] = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High']
]
const PROVIDERS: [AiProvider, string][] = [
  ['anthropic', 'Claude (Anthropic)'],
  ['openai', 'OpenAI-compatible']
]
const CUSTOM = 'custom'

const fmt = (n: number): string => n.toLocaleString()

/**
 * Settings → AI & automation. Self-contained: every change is saved immediately (keys encrypted in the app store,
 * one per provider / service, everything else in ai-settings.json), independent of the dialog's Save button.
 */
export function AiSettings(): ReactElement {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [s, setS] = useState<Settings | null>(null)
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [key, setKey] = useState('')
  const [test, setTest] = useState<AiTestResult | 'running' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<{ list: string[]; error?: string; loading?: boolean } | null>(null)

  const refreshStatus = (): void => {
    aiApi.aiStatus().then(setStatus, (e) => setError(errorText(e)))
  }
  useEffect(() => {
    refreshStatus()
    aiApi.aiGetSettings().then(setS, (e) => setError(errorText(e)))
    aiApi.aiUsage().then(setUsage, () => {})
  }, [])

  const save = async (patch: Partial<Settings>): Promise<void> => {
    if (s) setS({ ...s, ...patch })
    try {
      setS(await aiApi.aiSaveSettings(patch))
      // Provider, address and model decide which key applies and whether the assistant can run.
      if ('provider' in patch || 'compatBaseUrl' in patch || 'compatModel' in patch) {
        refreshStatus()
        setTest(null)
      }
      if ('provider' in patch || 'compatBaseUrl' in patch) {
        setKey('')
        setModels(null)
      }
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return
    try {
      await aiApi.aiSetKey(key.trim())
      setKey('')
      setTest(null)
      refreshStatus()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const removeKey = async (): Promise<void> => {
    await aiApi.aiSetKey(null)
    refreshStatus()
    setTest(null)
    toast('API key removed', 'success')
  }

  const runTest = async (): Promise<void> => {
    setTest('running')
    const r = await aiApi.aiTestKey(key.trim() || undefined).catch((e): AiTestResult => ({ ok: false, error: errorText(e) }))
    setTest(r)
    aiApi.aiUsage().then(setUsage, () => {})
  }

  const loadModels = async (): Promise<void> => {
    setModels({ list: models?.list ?? [], loading: true })
    const r = await aiApi.aiListModels().catch((e) => ({ models: [] as string[], error: errorText(e) }))
    setModels({ list: r.models, error: r.error })
  }

  const compat = s?.provider === 'openai'
  const local = !!s && compat && isLocalAiUrl(s.compatBaseUrl)
  const service = s ? (COMPATIBLE_SERVICES.find((p) => p.baseUrl === s.compatBaseUrl)?.id ?? CUSTOM) : CUSTOM
  const placeholder =
    status?.source === 'settings'
      ? 'API key saved (encrypted) — type to replace'
      : status?.source === 'environment'
        ? 'Using ANTHROPIC_API_KEY from the environment'
        : local
          ? 'Not needed for a server on this computer'
          : compat
            ? 'API key of the service'
            : 'sk-ant-…'

  return (
    <div className="ai-settings">
      {error && <div className="notice error" style={{ marginBottom: 8 }}>{error}</div>}
      {s && (
        <div className="field top">
          <label>Provider</label>
          <div>
            <div className="segmented">
              {PROVIDERS.map(([v, l]) => (
                <button key={v} className={s.provider === v ? 'on' : ''} onClick={() => void save({ provider: v })}>
                  {l}
                </button>
              ))}
            </div>
            <div className="pref-hint">
              {compat
                ? 'Any service with the OpenAI Chat Completions API and tool calling: OpenAI (ChatGPT models), Gemini, Mistral, Groq, OpenRouter, DeepSeek, or a model on this computer with Ollama or LM Studio.'
                : 'Claude models through the Anthropic API.'}
            </div>
          </div>
        </div>
      )}

      {s && compat && (
        <>
          <div className="field">
            <label>Service</label>
            <div className="row">
              <select
                className="select"
                value={service}
                onChange={(e) => {
                  const p = COMPATIBLE_SERVICES.find((x) => x.id === e.target.value)
                  if (p) void save({ compatBaseUrl: p.baseUrl, compatModel: '' })
                }}
              >
                {COMPATIBLE_SERVICES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM}>Other address…</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Address</label>
            <input
              key={s.compatBaseUrl}
              className="input mono"
              style={{ width: '100%' }}
              defaultValue={s.compatBaseUrl}
              placeholder="https://…/v1"
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onBlur={(e) => e.target.value.trim() !== s.compatBaseUrl && void save({ compatBaseUrl: e.target.value })}
            />
          </div>
        </>
      )}

      <div className="field">
        <label>{compat ? 'API key' : 'Anthropic API key'}</label>
        <div className="row">
          <input
            className="input grow mono"
            type="password"
            value={key}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setKey(e.target.value)
              setTest(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
            onBlur={() => void saveKey()}
          />
          {status?.source === 'settings' && !key && (
            <button className="btn" onClick={() => void removeKey()}>
              Remove
            </button>
          )}
          <button className="btn" onClick={() => void runTest()} disabled={test === 'running' || (!key.trim() && status?.source === 'none')} title="Send a tiny request to check the key">
            {test === 'running' ? 'Testing…' : 'Test'}
          </button>
        </div>
      </div>
      {test && test !== 'running' && (
        <div className="field">
          <label />
          <span className={test.ok ? 'ai-test ok' : 'ai-test error-text'} style={{ fontSize: 12 }}>
            <Icon name={test.ok ? 'check' : 'warn'} size={12} style={{ verticalAlign: -2, color: test.ok ? 'var(--ok)' : undefined }} />{' '}
            {test.ok ? `Works — ${test.model} answered in ${fmt(test.ms ?? 0)} ms.` : test.error}
          </span>
        </div>
      )}

      {s && (
        <>
          {compat ? (
            <div className="field top">
              <label>Model</label>
              <div>
                <div className="row">
                  <input
                    key={`${s.compatBaseUrl}|${s.compatModel}`}
                    className="input grow mono"
                    list="ai-compat-models"
                    defaultValue={s.compatModel}
                    placeholder="Model id, e.g. llama3.2"
                    spellCheck={false}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    onBlur={(e) => e.target.value.trim() !== s.compatModel && void save({ compatModel: e.target.value })}
                  />
                  <datalist id="ai-compat-models">
                    {(models?.list ?? []).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button className="btn" disabled={models?.loading} onClick={() => void loadModels()} title="Ask the service which models it offers">
                    {models?.loading ? 'Loading…' : 'Load models'}
                  </button>
                </div>
                <div className="pref-hint">
                  {models?.error
                    ? models.error
                    : models && !models.loading
                      ? `${fmt(models.list.length)} models available — pick one from the list while typing.`
                      : 'Pick a model that supports tool calling, so the assistant can run read-only queries.'}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label>Model</label>
                <div className="row">
                  <select className="select" value={s.model} onChange={(e) => void save({ model: e.target.value as Settings['model'] })}>
                    {AI_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {AI_MODELS.find((m) => m.id === s.model)?.hint}
                  </span>
                </div>
              </div>
              <div className="field">
                <label>Effort</label>
                <div className="row">
                  <div className="segmented">
                    {EFFORTS.map(([v, l]) => (
                      <button key={v} className={s.effort === v ? 'on' : ''} onClick={() => void save({ effort: v })}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Higher effort thinks longer and uses more tokens.
                  </span>
                </div>
              </div>
            </>
          )}
          <div className="field top">
            <label>Privacy</label>
            <div className="col" style={{ gap: 6 }}>
              <label className="check">
                <input type="checkbox" checked={s.sendSamples} onChange={(e) => void save({ sendSamples: e.target.checked })} />
                Send sample values to the AI
              </label>
              <span className="muted" style={{ fontSize: 12, marginLeft: 22, marginTop: -4 }}>
                Off: prompts carry field names and types only.
              </span>
              <label className="check">
                <input type="checkbox" checked={s.allowQueries} onChange={(e) => void save({ allowQueries: e.target.checked })} />
                Let the assistant run read-only queries
              </label>
              <span className="muted" style={{ fontSize: 12, marginLeft: 22, marginTop: -4 }}>
                find, aggregate, count and explain on the active connection; their results are sent to the AI. Writes are always refused.
              </span>
            </div>
          </div>
          <div className="field">
            <label>Max documents per result</label>
            <div className="row">
              <input
                className="input"
                style={{ width: 70 }}
                type="number"
                min={1}
                max={50}
                value={s.maxDocs}
                disabled={!s.allowQueries}
                onChange={(e) => setS({ ...s, maxDocs: Number(e.target.value) || 1 })}
                onBlur={(e) => void save({ maxDocs: Number(e.target.value) || 20 })}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                1–50, and at most 20 KB of text per tool result.
              </span>
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label>Usage this session</label>
        <div className="row" style={{ fontSize: 12 }}>
          {usage ? (
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(usage.requests)} request{usage.requests === 1 ? '' : 's'} · {fmt(usage.input)} input · {fmt(usage.output)} output · cache {fmt(usage.cacheRead)} read / {fmt(usage.cacheWrite)} written tokens
            </span>
          ) : (
            <span className="muted">—</span>
          )}
          {usage && usage.requests > 0 && (
            <button className="btn small ghost" onClick={() => void aiApi.aiResetUsage().then(setUsage)}>
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
