import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { MigrationApi } from '@shared/migrationApi'

type Promisified = { [K in keyof MigrationApi]: (...args: Parameters<MigrationApi[K]>) => Promise<Awaited<ReturnType<MigrationApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** SQL ⇄ MongoDB migration methods, invoked over the same IPC channel and codec as `api`. */
export const migrationApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified
