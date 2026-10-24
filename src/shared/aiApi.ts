import type { AiRequest, AiSuggestion, Doc, PlaygroundLanguage } from './api'

/**
 * Phase 5 AI contract (Claude via the Anthropic API, main process only). The assistant streams its answer
 * through the `ai:stream` event while `aiChatSend` is pending.
 */

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'Most capable (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'Balanced speed and quality' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'Fastest, lowest cost' }
] as const

export type AiModel = (typeof AI_MODELS)[number]['id']
export type AiEffort = 'low' | 'medium' | 'high'

/** Claude through the Anthropic API, or any service that speaks the OpenAI Chat Completions API with tool calling. */
export type AiProvider = 'anthropic' | 'openai'

/** Presets for OpenAI-compatible services (the address can also be typed). Models are listed by the service. */
export const COMPATIBLE_SERVICES = [
  { id: 'openai', label: 'OpenAI (ChatGPT models)', baseUrl: 'https://api.openai.com/v1' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'ollama', label: 'Ollama (this computer)', baseUrl: 'http://localhost:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio (this computer)', baseUrl: 'http://localhost:1234/v1' }
] as const

/** Servers on this computer (Ollama, LM Studio…) need no API key. */
export const isLocalAiUrl = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url.trim())

/** Host shown in messages ("api.openai.com"). */
export function aiHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface AiSettings {
  provider: AiProvider
  /** OpenAI-compatible provider: API address (…/v1) and model id as the service names it. */
  compatBaseUrl: string
  compatModel: string
  model: AiModel
  effort: AiEffort
  /** Send sample documents (values) with prompts; off = field names and types only. */
  sendSamples: boolean
  /** Let the assistant run read-only queries (find, aggregate, count, explain) against the live connection. */
  allowQueries: boolean
  /** Documents per tool result (1–50). */
  maxDocs: number
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'anthropic',
  compatBaseUrl: 'https://api.openai.com/v1',
  compatModel: '',
  model: 'claude-opus-5-5',
  effort: 'medium',
  sendSamples: false,
  allowQueries: true,
  maxDocs: 20
}

/** Tokens used since the app started. */
export interface AiUsage {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface AiStatus {
  configured: boolean
  /** Where the key comes from; 'local' = a server on this computer that needs none. */
  source: 'settings' | 'environment' | 'local' | 'none'
  provider: AiProvider
  /** "Claude" or the host of the OpenAI-compatible service. */
  label: string
  /** OpenAI-compatible provider without a chosen model. */
  missingModel?: boolean
}

export interface AiModelList {
  models: string[]
  error?: string
}

export interface AiTestResult {
  ok: boolean
  model?: string
  ms?: number
  error?: string
}

/** Where the assistant / an action is pointed: the active tab's connection, database and collection. */
export interface AiTarget {
  connId: string
  db?: string
  coll?: string
}

export interface AiChatRequest {
  chatId: string
  target: AiTarget | null
  text: string
}

export interface AiChatResult {
  stopReason: 'end_turn' | 'max_tokens' | 'stopped' | 'max_steps' | 'refusal'
  /** Shown under the answer (cut off, stopped, refusal explanation…). */
  note?: string
}

export type AiStreamEvent =
  | { chatId: string; kind: 'text'; delta: string }
  | { chatId: string; kind: 'tool'; id: string; name: string; input: Doc }
  | { chatId: string; kind: 'toolResult'; id: string; ok: boolean; summary: string; preview: string }
  | { chatId: string; kind: 'usage'; usage: AiUsage; turn: AiUsage }

/** Query bar texts, as typed. */
export interface AiQueryTexts {
  query: string
  projection: string
  sort: string
  skip: string
  limit: string
}

export interface AiExplainQueryRequest {
  connId: string
  db: string
  coll: string
  query: AiQueryTexts
  /** An explain result the user already has (else the main process runs executionStats). */
  explain?: Doc
}

export interface AiFixQueryRequest {
  connId: string
  db: string
  coll: string
  query: AiQueryTexts
  error: { part: string; message: string }
}

export interface AiFixResult {
  query: string
  projection: string
  sort: string
  limit: string
  explanation: string
}

export interface AiPipelineRequest {
  connId: string
  db: string
  coll: string
  prompt: string
  /** Current pipeline text (shell syntax), to extend or refine. */
  current: string
}

export interface AiPipelineResult {
  pipeline: string
  explanation: string
}

export interface AiExplainStageRequest {
  connId: string
  db: string
  coll: string
  pipeline: string
  /** 0-based stage index. */
  index: number
}

export interface AiCodeRequest {
  connId: string
  db: string
  prompt: string
  language: PlaygroundLanguage
  /** The script around the cursor and the selected text, if any. */
  code: string
  selection: string
}

export interface AiCodeResult {
  code: string
  explanation: string
}

export interface AiText {
  text: string
}

/** Renderer-callable AI methods; implemented by `aiHandlers()` in src/main/ai/index.ts. */
export interface AiApi {
  aiStatus(): AiStatus
  /** Key of the selected provider (OpenAI-compatible: of the selected address). */
  aiSetKey(key: string | null): void
  aiSuggest(req: AiRequest): AiSuggestion
  aiGetSettings(): AiSettings
  aiSaveSettings(s: Partial<AiSettings>): AiSettings
  /** Tiny request with the given key (or the saved / environment one). */
  aiTestKey(key?: string): AiTestResult
  /** Models of the selected provider (OpenAI-compatible: as listed by the service). */
  aiListModels(): AiModelList
  aiUsage(): AiUsage
  aiResetUsage(): AiUsage

  /** Resolves when the turn ends; text and tool activity arrive as `ai:stream` events. */
  aiChatSend(req: AiChatRequest): AiChatResult
  aiChatStop(chatId: string): void
  aiChatReset(chatId: string): void

  aiExplainQuery(req: AiExplainQueryRequest): AiText
  aiFixQuery(req: AiFixQueryRequest): AiFixResult
  aiExplainPlan(req: { connId: string; db: string; coll: string; explain: Doc; label?: string }): AiText
  aiGeneratePipeline(req: AiPipelineRequest): AiPipelineResult
  aiExplainStage(req: AiExplainStageRequest): AiText
  aiGenerateCode(req: AiCodeRequest): AiCodeResult
}

export interface AiEvents {
  'ai:stream': AiStreamEvent
}
