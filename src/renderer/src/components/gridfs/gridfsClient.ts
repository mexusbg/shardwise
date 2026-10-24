import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { GridFsApi } from '@shared/gridfsApi'

type Promisified = { [K in keyof GridFsApi]: (...args: Parameters<GridFsApi[K]>) => Promise<Awaited<ReturnType<GridFsApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** GridFS methods, invoked over the same IPC channel and codec as `api`. */
export const gridfsApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
