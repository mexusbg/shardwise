import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { CopyApi } from '@shared/copyApi'

type Promisified = { [K in keyof CopyApi]: (...args: Parameters<CopyApi[K]>) => Promise<Awaited<ReturnType<CopyApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Copy / paste methods, invoked over the same IPC channel and codec as `api`. */
export const copyApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
