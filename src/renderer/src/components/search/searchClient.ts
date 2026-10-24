import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { SearchApi, SearchEvent } from '@shared/searchApi'

type Promisified = { [K in keyof SearchApi]: (...args: Parameters<SearchApi[K]>) => Promise<Awaited<ReturnType<SearchApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Find in Database methods, invoked over the same IPC channel and codec as `api`. */
export const searchApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified

/** Subscribes to streamed search results. */
export function onSearchEvent(cb: (e: SearchEvent) => void): () => void {
  return window.bridge.on((channel, payload) => {
    if (channel === 'search:event') cb(decodeIpc(payload) as SearchEvent)
  })
}
