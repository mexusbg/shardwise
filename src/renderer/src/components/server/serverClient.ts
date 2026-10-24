import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { ServerApi } from '@shared/serverApi'

type Promisified = { [K in keyof ServerApi]: (...args: Parameters<ServerApi[K]>) => Promise<Awaited<ReturnType<ServerApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Server status, validation and view methods, invoked over the same IPC channel and codec as `api`. */
export const serverApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
