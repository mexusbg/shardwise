import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaTextBlockParam,
  MessageCreateParamsNonStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions/completions'
import { AI_MODELS, aiHost, isLocalAiUrl } from '@shared/aiApi'
import type { AiModelList, AiSettings, AiStatus, AiTestResult, AiUsage } from '@shared/aiApi'
import { addUsage, emptyUsage } from './settings'
import type { AiSettingsStore } from './settings'
import { compatError, compatSecret, compatUsage, createCompatible, isFormatUnsupported, parseJsonAnswer } from './compatible'
import type { CompatibleLike } from './compatible'

export const SECRET = 'anthropicApiKey'
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
export const STREAM_MAX_TOKENS = 32000
export const MAX_TOKENS = 16000

/** The slice of the SDK client used here, so tests can inject a fake. */
export interface StreamLike {
  on(event: 'text', listener: (delta: string, snapshot: string) => void): unknown
  finalMessage(): Promise<BetaMessage>
  abort(): void
}

export interface AnthropicLike {
  beta: {
    messages: {
      create(params: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<BetaMessage>
      stream(params: BetaMessageStreamParams, options?: { signal?: AbortSignal }): StreamLike
    }
  }
}

export interface AiDeps {
  secrets: { getSecret(name: string): Promise<string | undefined> }
  settings: Pick<AiSettingsStore, 'get' | 'save'>
  /** Defaults to the real SDK client (saved key, else environment / `ant auth` credentials). */
  createClient?: (apiKey: string | undefined) => AnthropicLike
  /** OpenAI-compatible client; defaults to the OpenAI SDK pointed at the service's address. */
  createCompat?: (baseUrl: string, apiKey: string | undefined) => CompatibleLike
  /** HTTP for the real client (the app passes its proxy-aware fetch); defaults to the global fetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/** A request ended without a usable answer (refusal, cut off). The message is shown to the user as is. */
export class AiStopError extends Error {
  constructor(
    public reason: 'refusal' | 'max_tokens' | 'context',
    message: string
  ) {
    super(message)
  }
}

export const refusalText = (m: Pick<BetaMessage, 'stop_details'>): string =>
  `Claude declined this request${m.stop_details?.explanation ? `: ${m.stop_details.explanation}` : '.'}`

/** Message of a proxy failure somewhere in the error's cause chain (see src/main/net/proxy.ts). */
function proxyCause(e: unknown): string | null {
  for (let c: unknown = e, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    if ((c as Error).name === 'ProxyError') return (c as Error).message
  }
  return null
}

/** SDK errors → messages for the UI (most specific class first). */
export function friendlyError(e: unknown): Error {
  if (e instanceof AiStopError) return e
  if (e instanceof Anthropic.AuthenticationError) return new Error('The Anthropic API key was rejected. Check it in Settings → AI & automation.')
  if (e instanceof Anthropic.PermissionDeniedError) return new Error(`This API key cannot use the selected model: ${e.message}`)
  if (e instanceof Anthropic.RateLimitError) return new Error('The Anthropic API rate limit was reached. Try again in a moment.')
  if (e instanceof Anthropic.APIConnectionError) {
    const proxy = proxyCause(e)
    if (proxy) return new Error(`Could not reach the Anthropic API through the proxy: ${proxy} (Settings → Network & tools)`)
    return new Error('Could not reach the Anthropic API. Check your internet connection.')
  }
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529) return new Error('The Anthropic API is overloaded right now. Try again in a moment.')
    return new Error(`Anthropic API error${e.status ? ` ${e.status}` : ''}: ${e.message}`)
  }
  if (e instanceof Error && /authentication method|api key|apiKey/i.test(e.message)) {
    return new Error('No Anthropic API key is configured. Add one in Settings → AI & automation.')
  }
  return e instanceof Error ? e : new Error(String(e))
}

export const isAbort = (e: unknown): boolean => e instanceof Anthropic.APIUserAbortError || (e as Error)?.name === 'AbortError'

const textOf = (m: BetaMessage): string => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')

/** Shared client, settings and session usage for every AI feature. */
export class AiCore {
  usage: AiUsage = emptyUsage()

  constructor(public deps: AiDeps) {}

  async status(): Promise<AiStatus> {
    const s = await this.settings()
    if (s.provider === 'openai') {
      const key = await this.deps.secrets.getSecret(compatSecret(s.compatBaseUrl))
      const local = isLocalAiUrl(s.compatBaseUrl)
      const source = key ? 'settings' : local ? 'local' : 'none'
      return { configured: source !== 'none' && !!s.compatModel, source, provider: 'openai', label: aiHost(s.compatBaseUrl), ...(s.compatModel ? {} : { missingModel: true }) }
    }
    const base = { provider: 'anthropic', label: 'Claude' } as const
    if (await this.deps.secrets.getSecret(SECRET)) return { configured: true, source: 'settings', ...base }
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return { configured: true, source: 'environment', ...base }
    return { configured: false, source: 'none', ...base }
  }

  /** Secret name of the selected provider's key. */
  async secretName(): Promise<string> {
    const s = await this.settings()
    return s.provider === 'openai' ? compatSecret(s.compatBaseUrl) : SECRET
  }

  /** Client of the OpenAI-compatible service in `s` (saved key of that service, or `key`). */
  async compat(s: AiSettings, key?: string): Promise<CompatibleLike> {
    const apiKey = key || (await this.deps.secrets.getSecret(compatSecret(s.compatBaseUrl)))
    if (this.deps.createCompat) return this.deps.createCompat(s.compatBaseUrl, apiKey)
    return createCompatible(s.compatBaseUrl, apiKey, this.deps.fetch)
  }

  /** The chosen model of an OpenAI-compatible service (there is no default: services name their own). */
  compatModel(s: AiSettings): string {
    if (!s.compatModel) throw new Error(`Choose a model of ${aiHost(s.compatBaseUrl)} in Settings → AI & automation.`)
    return s.compatModel
  }

  settings(): Promise<AiSettings> {
    return this.deps.settings.get()
  }

  async client(key?: string): Promise<AnthropicLike> {
    const apiKey = key || (await this.deps.secrets.getSecret(SECRET))
    if (this.deps.createClient) return this.deps.createClient(apiKey)
    const fetch = this.deps.fetch
    return new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(fetch ? { fetch } : {}) }) as AnthropicLike
  }

  /** Model, beta header and server-side fallback shared by every request. */
  base(s: AiSettings): Pick<MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks'> {
    return { model: s.model, betas: [FALLBACK_BETA], fallbacks: 'default' }
  }

  /** Adds a response's usage to the session total; returns this response's usage. */
  record(u: Parameters<typeof addUsage>[1]): AiUsage {
    this.usage = addUsage(this.usage, u)
    return addUsage(emptyUsage(), u)
  }

  resetUsage(): AiUsage {
    this.usage = emptyUsage()
    return this.usage
  }

  /** One non-streaming request; returns the text after checking the stop reason. */
  async complete(o: { system: string; user: string; format?: BetaOutputConfig['format']; effort?: AiSettings['effort'] }): Promise<string> {
    const s = await this.settings()
    if (s.provider === 'openai') return this.completeCompat(s, o)
    const client = await this.client()
    let msg: BetaMessage
    try {
      msg = await client.beta.messages.create({
        ...this.base(s),
        max_tokens: MAX_TOKENS,
        output_config: { effort: o.effort ?? s.effort, ...(o.format ? { format: o.format } : {}) },
        system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }] satisfies BetaTextBlockParam[],
        messages: [{ role: 'user', content: o.user }]
      })
    } catch (e) {
      throw friendlyError(e)
    }
    this.record(msg.usage)
    if (msg.stop_reason === 'refusal') throw new AiStopError('refusal', refusalText(msg))
    if (msg.stop_reason === 'max_tokens') throw new AiStopError('max_tokens', 'The answer was cut off. Try a more specific request.')
    if (msg.stop_reason === 'model_context_window_exceeded') throw new AiStopError('context', 'The request is too large for the model. Try a smaller selection.')
    return textOf(msg)
  }

  /**
   * One request to an OpenAI-compatible service. JSON answers ask for structured output and fall back to plain
   * JSON (schema in the prompt) where the service does not support it.
   */
  private async completeCompat(s: AiSettings, o: { system: string; user: string; format?: BetaOutputConfig['format'] }): Promise<string> {
    const model = this.compatModel(s)
    const client = await this.compat(s)
    const schema = o.format && 'schema' in o.format ? (o.format.schema as Record<string, unknown>) : undefined
    const system = schema ? `${o.system}\n\nAnswer with a single JSON object only (no other text), matching this JSON schema:\n${JSON.stringify(schema)}` : o.system
    const base: ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: o.user }
      ]
    }
    let r: ChatCompletion
    try {
      try {
        r = await client.chat.completions.create(schema ? { ...base, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } } } : base)
      } catch (e) {
        if (!schema || !isFormatUnsupported(e)) throw e
        r = await client.chat.completions.create(base)
      }
    } catch (e) {
      throw compatError(e, s.compatBaseUrl, model)
    }
    this.record(compatUsage(r.usage))
    const c = r.choices[0]
    if (c?.message?.refusal) throw new AiStopError('refusal', `The model declined this request: ${c.message.refusal}`)
    if (c?.finish_reason === 'content_filter') throw new AiStopError('refusal', `The content filter of ${aiHost(s.compatBaseUrl)} blocked this answer.`)
    if (c?.finish_reason === 'length') throw new AiStopError('max_tokens', 'The answer was cut off. Try a more specific request.')
    return c?.message?.content ?? ''
  }

  async json<T>(o: { system: string; user: string; schema: Record<string, unknown> }): Promise<T> {
    const text = await this.complete({ system: o.system, user: o.user, format: { type: 'json_schema', schema: o.schema } })
    try {
      return parseJsonAnswer<T>(text)
    } catch {
      throw new Error('The AI answer could not be read. Try again.')
    }
  }

  /** "Test key": a tiny request with the given or configured credentials. */
  async test(key?: string): Promise<AiTestResult> {
    const s = await this.settings()
    const t0 = Date.now()
    if (s.provider === 'openai') {
      try {
        const client = await this.compat(s, key)
        // Without a model yet, listing the models checks the address and the key.
        if (!s.compatModel) {
          const n = (await client.models.list()).data.length
          return { ok: true, model: `${aiHost(s.compatBaseUrl)} (${n} models)`, ms: Date.now() - t0 }
        }
        const r = await client.chat.completions.create({ model: s.compatModel, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] })
        this.record(compatUsage(r.usage))
        return { ok: true, model: r.model || s.compatModel, ms: Date.now() - t0 }
      } catch (e) {
        return { ok: false, error: compatError(e, s.compatBaseUrl, s.compatModel).message }
      }
    }
    try {
      const client = await this.client(key)
      const msg = await client.beta.messages.create({
        ...this.base(s),
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }]
      })
      this.record(msg.usage)
      if (msg.stop_reason === 'refusal') return { ok: false, error: refusalText(msg) }
      return { ok: true, model: msg.model, ms: Date.now() - t0 }
    } catch (e) {
      return { ok: false, error: friendlyError(e).message }
    }
  }

  /** Models to choose from: Claude's, or those the OpenAI-compatible service lists. */
  async listModels(): Promise<AiModelList> {
    const s = await this.settings()
    if (s.provider !== 'openai') return { models: AI_MODELS.map((m) => m.id) }
    try {
      const page = await (await this.compat(s)).models.list()
      return { models: [...new Set(page.data.map((m) => m.id))].sort((a, b) => a.localeCompare(b)) }
    } catch (e) {
      return { models: [], error: compatError(e, s.compatBaseUrl, s.compatModel).message }
    }
  }
}
