import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { DocScope, FieldOp, UpdateRequest, UpdateResult, WriteResult } from '@shared/api'
import type { ChangeHistoryApi, WriteOptions } from '@shared/changeHistoryApi'

type Promisified = { [K in keyof ChangeHistoryApi]: (...args: Parameters<ChangeHistoryApi[K]>) => Promise<Awaited<ReturnType<ChangeHistoryApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Change History methods, invoked over the same IPC channel and codec as `api`. */
export const changesApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified

/** Multi-document editing methods with their optional Change History options (the last argument). */
export const historyWrites = {
  updateField: (connId: string, db: string, coll: string, scope: DocScope, op: FieldOp, opts?: WriteOptions): Promise<WriteResult> =>
    call('updateField', opts ? [connId, db, coll, scope, op, opts] : [connId, db, coll, scope, op]) as Promise<WriteResult>,
  deleteDocuments: (connId: string, db: string, coll: string, scope: DocScope, opts?: WriteOptions): Promise<number> =>
    call('deleteDocuments', opts ? [connId, db, coll, scope, opts] : [connId, db, coll, scope]) as Promise<number>,
  updateDocuments: (connId: string, db: string, coll: string, req: UpdateRequest, opts?: WriteOptions): Promise<UpdateResult> =>
    call('updateDocuments', opts ? [connId, db, coll, req, opts] : [connId, db, coll, req]) as Promise<UpdateResult>
}
