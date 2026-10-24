import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { AI_MODELS, DEFAULT_AI_SETTINGS } from '@shared/aiApi'
import type { AiEffort, AiModel, AiSettings, AiUsage } from '@shared/aiApi'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high']
export const MAX_TOOL_DOCS = 50

/** Unknown or out-of-range values fall back to the defaults. */
export function normalizeSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const r = raw ?? {}
  const maxDocs = Math.floor(Number(r.maxDocs))
  const url = typeof r.compatBaseUrl === 'string' ? r.compatBaseUrl.trim().replace(/\/+$/, '') : ''
  return {
    provider: r.provider === 'openai' ? 'openai' : 'anthropic',
    compatBaseUrl: /^https?:\/\/\S+$/i.test(url) ? url : DEFAULT_AI_SETTINGS.compatBaseUrl,
    compatModel: typeof r.compatModel === 'string' ? r.compatModel.trim() : DEFAULT_AI_SETTINGS.compatModel,
    model: AI_MODELS.some((m) => m.id === r.model) ? (r.model as AiModel) : DEFAULT_AI_SETTINGS.model,
    effort: EFFORTS.includes(r.effort as AiEffort) ? (r.effort as AiEffort) : DEFAULT_AI_SETTINGS.effort,
    sendSamples: typeof r.sendSamples === 'boolean' ? r.sendSamples : DEFAULT_AI_SETTINGS.sendSamples,
    allowQueries: typeof r.allowQueries === 'boolean' ? r.allowQueries : DEFAULT_AI_SETTINGS.allowQueries,
    maxDocs: Number.isFinite(maxDocs) && maxDocs > 0 ? Math.min(maxDocs, MAX_TOOL_DOCS) : DEFAULT_AI_SETTINGS.maxDocs
  }
}

/** Non-secret AI settings in `<userData>/ai-settings.json` (the API key stays in the encrypted store). */
export class AiSettingsStore {
  private data: AiSettings | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private file: string) {}

  static path(userData: string): string {
    return join(userData, 'ai-settings.json')
  }

  async get(): Promise<AiSettings> {
    if (this.data) return { ...this.data }
    try {
      this.data = normalizeSettings(JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<AiSettings>)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code && code !== 'ENOENT') throw e
      // Missing or unreadable JSON: start from the defaults.
      this.data = { ...DEFAULT_AI_SETTINGS }
    }
    return { ...this.data }
  }

  async save(patch: Partial<AiSettings>): Promise<AiSettings> {
    const next = normalizeSettings({ ...(await this.get()), ...patch })
    this.data = next
    const snapshot = JSON.stringify(next, null, 2)
    this.writing = this.writing.then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    })
    await this.writing
    return { ...next }
  }
}

export const emptyUsage = (): AiUsage => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function addUsage(total: AiUsage, u: UsageLike | null | undefined): AiUsage {
  return {
    requests: total.requests + 1,
    input: total.input + (u?.input_tokens ?? 0),
    output: total.output + (u?.output_tokens ?? 0),
    cacheRead: total.cacheRead + (u?.cache_read_input_tokens ?? 0),
    cacheWrite: total.cacheWrite + (u?.cache_creation_input_tokens ?? 0)
  }
}
