import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { CompareApi } from '@shared/compareApi'

type Promisified = { [K in keyof CompareApi]: (...args: Parameters<CompareApi[K]>) => Promise<Awaited<ReturnType<CompareApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Diff & Sync methods, invoked over the same IPC channel and codec as `api`. */
export const compareApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
