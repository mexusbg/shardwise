import type { MongoClient } from 'mongodb'
import { DEFAULT_AI_SETTINGS } from '@shared/aiApi'
import type { AiApi, AiStreamEvent } from '@shared/aiApi'
import type { AiRequest, AiSuggestion } from '@shared/api'
import { AiCore } from './client'
import type { AiDeps, AnthropicLike } from './client'
import type { CompatibleLike } from './compatible'
import { AiSettingsStore } from './settings'

export { AiSettingsStore } from './settings'
import { Assistant } from './assistant'
import { suggestQuery } from './suggest'
import * as actions from './actions'

export interface AiServiceOptions {
  secrets: { getSecret(name: string): Promise<string | undefined>; setSecret(name: string, value: string | null): Promise<void> }
  /** Live client of a connection (`ConnectionManager.get`). */
  mongo: (connId: string) => MongoClient
  /** `<userData>/ai-settings.json`, see AiSettingsStore.path. */
  settingsFile: string
  emit: (e: AiStreamEvent) => void
  createClient?: (apiKey: string | undefined) => AnthropicLike
  createCompat?: (baseUrl: string, apiKey: string | undefined) => CompatibleLike
  /** HTTP for the Anthropic SDK (the app's proxy-aware fetch). */
  fetch?: AiDeps['fetch']
}

/** Every AI feature of the main process: settings, Ask AI, the assistant and the one-shot actions. */
export class AiService {
  readonly core: AiCore
  readonly assistant: Assistant

  constructor(private o: AiServiceOptions) {
    this.core = new AiCore({ secrets: o.secrets, settings: new AiSettingsStore(o.settingsFile), createClient: o.createClient, createCompat: o.createCompat, fetch: o.fetch })
    this.assistant = new Assistant({ core: this.core, mongo: o.mongo, emit: o.emit })
  }

  /** Saves (or with null removes) the key of the selected provider / OpenAI-compatible service. */
  async setKey(key: string | null): Promise<void> {
    return this.o.secrets.setSecret(await this.core.secretName(), key?.trim() || null)
  }

  mongo(connId: string): MongoClient {
    return this.o.mongo(connId)
  }

  dispose(): void {
    this.assistant.stopAll()
  }
}

type Handlers = { [K in keyof AiApi]: (...args: Parameters<AiApi[K]>) => Promise<ReturnType<AiApi[K]>> | ReturnType<AiApi[K]> }

export function aiHandlers(ai: AiService): Handlers {
  const { core, assistant } = ai
  return {
    aiStatus: () => core.status(),
    aiSetKey: (key) => ai.setKey(key),
    aiSuggest: (req) => suggestQuery(core, ai.mongo(req.connId), req),
    aiGetSettings: () => core.settings(),
    aiSaveSettings: (s) => core.deps.settings.save(s),
    aiTestKey: (key) => core.test(key),
    aiListModels: () => core.listModels(),
    aiUsage: () => core.usage,
    aiResetUsage: () => core.resetUsage(),

    aiChatSend: (req) => assistant.send(req),
    aiChatStop: (chatId) => assistant.stop(chatId),
    aiChatReset: (chatId) => assistant.reset(chatId),

    aiExplainQuery: (req) => actions.explainQuery(core, ai.mongo(req.connId), req),
    aiFixQuery: (req) => actions.fixQuery(core, ai.mongo(req.connId), req),
    aiExplainPlan: (req) => actions.explainPlan(core, ai.mongo(req.connId), req),
    aiGeneratePipeline: (req) => actions.generatePipeline(core, ai.mongo(req.connId), req),
    aiExplainStage: (req) => actions.explainStage(core, ai.mongo(req.connId), req),
    aiGenerateCode: (req) => actions.generateCode(core, ai.mongo(req.connId), req)
  }
}

// ---------------------------------------------------------------------------
// Phase 3 entry points, kept so src/main/api.ts compiles until it is switched to aiHandlers().
// ---------------------------------------------------------------------------

interface SecretStore {
  getSecret(name: string): Promise<string | undefined>
}

const legacyCore = (store: SecretStore): AiCore =>
  new AiCore({ secrets: store, settings: { get: async () => ({ ...DEFAULT_AI_SETTINGS }), save: async () => ({ ...DEFAULT_AI_SETTINGS }) } })

export function aiStatus(store: SecretStore): ReturnType<AiCore['status']> {
  return legacyCore(store).status()
}

export function aiSuggest(store: SecretStore, client: MongoClient, req: AiRequest): Promise<AiSuggestion> {
  return suggestQuery(legacyCore(store), client, req)
}
