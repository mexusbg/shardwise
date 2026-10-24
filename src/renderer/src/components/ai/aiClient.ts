import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { AiApi, AiEvents } from '@shared/aiApi'

type Promisified = { [K in keyof AiApi]: (...args: Parameters<AiApi[K]>) => Promise<Awaited<ReturnType<AiApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** AI methods, invoked over the same IPC channel and codec as `api`. */
export const aiApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified

/** Subscribe to an AI push event from the main process. */
export function onAiEvent<K extends keyof AiEvents>(channel: K, cb: (payload: AiEvents[K]) => void): () => void {
  return window.bridge.on((ch, payload) => {
    if (ch === channel) cb(decodeIpc(payload) as AiEvents[K])
  })
}
