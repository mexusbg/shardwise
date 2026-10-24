import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { ProxyApi } from '@shared/proxyApi'

type Promisified = { [K in keyof ProxyApi]: (...args: Parameters<ProxyApi[K]>) => Promise<Awaited<ReturnType<ProxyApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Proxy (Settings → Network & tools) methods, invoked over the same IPC channel and codec as `api`. */
export const proxyApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
