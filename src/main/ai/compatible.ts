import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionTool
} from 'openai/resources/chat/completions/completions'
import type { ChatCompletionStreamParams } from 'openai/lib/ChatCompletionStream'
import { aiHost, isLocalAiUrl } from '@shared/aiApi'
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'

/**
 * OpenAI-compatible providers: OpenAI, Gemini, Mistral, Groq, OpenRouter, DeepSeek, Ollama, LM Studio… — any
 * service with the Chat Completions API and tool calling. Claude keeps using the Anthropic API (client.ts).
 */

/** The slice of the OpenAI SDK used here, so tests can inject a fake. */
export interface CompatStreamLike {
  on(event: 'content', listener: (delta: string, snapshot: string) => void): unknown
  finalChatCompletion(): Promise<ChatCompletion>
  abort(): void
}

export interface CompatibleLike {
  chat: {
    completions: {
      create(params: ChatCompletionCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<ChatCompletion>
      stream(params: ChatCompletionStreamParams, options?: { signal?: AbortSignal }): CompatStreamLike
    }
  }
  models: { list(): PromiseLike<{ data: { id: string }[] }> }
}

/** Encrypted-store name of the key of one service (keys are kept per host, so switching services keeps them). */
export const compatSecret = (baseUrl: string): string => `aiCompatKey:${aiHost(baseUrl).toLowerCase()}`

export function createCompatible(baseUrl: string, apiKey: string | undefined, fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): CompatibleLike {
  // Local servers ignore the key, but the SDK requires one.
  return new OpenAI({ baseURL: baseUrl, apiKey: apiKey || 'not-needed', maxRetries: 1, ...(fetch ? { fetch } : {}) }) as unknown as CompatibleLike
}

/** The assistant's read-only tools as function tools. */
export function compatTools(tools: BetaTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema as Record<string, unknown> } }))
}

/** Usage in the Anthropic shape the app counts (cached prompt tokens count as cache reads). */
export function compatUsage(u: ChatCompletion['usage'] | null | undefined): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
  return { input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached), output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: cached }
}

/** Message of a proxy failure somewhere in the error's cause chain (see src/main/net/proxy.ts). */
function proxyCause(e: unknown): string | null {
  for (let c: unknown = e, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    if ((c as Error).name === 'ProxyError') return (c as Error).message
  }
  return null
}

/** SDK errors → messages for the UI, naming the service. */
export function compatError(e: unknown, baseUrl: string, model: string): Error {
  const host = aiHost(baseUrl)
  if (e instanceof OpenAI.AuthenticationError) return new Error(`The API key was rejected by ${host}. Check it in Settings → AI & automation.`)
  if (e instanceof OpenAI.PermissionDeniedError) return new Error(`${host} refused the request: ${e.message}`)
  if (e instanceof OpenAI.NotFoundError) return new Error(`${host} does not know the model "${model}". Load the model list in Settings → AI & automation.`)
  if (e instanceof OpenAI.RateLimitError) return new Error(`${host}: rate limit or quota reached. Try again in a moment.`)
  if (e instanceof OpenAI.APIConnectionError) {
    const proxy = proxyCause(e)
    if (proxy) return new Error(`Could not reach ${host} through the proxy: ${proxy} (Settings → Network & tools)`)
    return new Error(isLocalAiUrl(baseUrl) ? `Could not reach ${host}. Is the local server (Ollama, LM Studio…) running?` : `Could not reach ${host}. Check the address and your internet connection.`)
  }
  if (e instanceof OpenAI.APIError) return new Error(`${host} error${e.status ? ` ${e.status}` : ''}: ${e.message}`)
  return e instanceof Error ? e : new Error(String(e))
}

export const isCompatAbort = (e: unknown): boolean => e instanceof OpenAI.APIUserAbortError || (e as Error)?.name === 'AbortError'

/** A 400 about response_format: the service does not support structured output (retry without it). */
export const isFormatUnsupported = (e: unknown): boolean => e instanceof OpenAI.BadRequestError && /response_format|json_schema|structured/i.test(e.message)

/** JSON in a model answer, with or without a ```json fence. */
export function parseJsonAnswer<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.search(/[{[]/)
  return JSON.parse(start > 0 ? body.slice(start) : body) as T
}
