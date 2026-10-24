import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { Api, ApiEvents, ApiMethod } from '@shared/api'

type Promisified = { [K in ApiMethod]: (...args: Parameters<Api[K]>) => Promise<Awaited<ReturnType<Api[K]>>> }

async function call(method: ApiMethod, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Typed proxy: `api.find(...)` invokes the main-process method of the same name. */
export const api = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method as ApiMethod, args)
}) as Promisified

type Listener<K extends keyof ApiEvents> = (payload: ApiEvents[K]) => void
const listeners = new Map<string, Set<Listener<never>>>()

window.bridge.on((channel, payload) => {
  const set = listeners.get(channel)
  if (!set) return
  const value = decodeIpc(payload) as never
  set.forEach((l) => l(value))
})

export function onEvent<K extends keyof ApiEvents>(channel: K, cb: Listener<K>): () => void {
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  set.add(cb as Listener<never>)
  return () => set!.delete(cb as Listener<never>)
}

export const isMac = window.bridge.platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'
