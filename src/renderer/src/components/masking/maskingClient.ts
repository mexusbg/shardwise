import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { MaskingApi } from '@shared/maskingApi'

type Promisified = { [K in keyof MaskingApi]: (...args: Parameters<MaskingApi[K]>) => Promise<Awaited<ReturnType<MaskingApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Masking & Restructure Fields methods, invoked over the same IPC channel and codec as `api`. */
export const maskingApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
