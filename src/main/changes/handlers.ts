import type { ChangeHistoryApi } from '@shared/changeHistoryApi'
import { Restorer } from './restore'
import type { ChangeHistory } from './store'

type Handlers = { [K in keyof ChangeHistoryApi]: (...args: Parameters<ChangeHistoryApi[K]>) => Promise<ReturnType<ChangeHistoryApi[K]>> | ReturnType<ChangeHistoryApi[K]> }

/** IPC handlers for the Change History methods; spread into createApi()'s result. */
export function changeHistoryHandlers(h: ChangeHistory): Handlers {
  const restorer = new Restorer(h)
  const configId = (connId: string): string => h.mgr.config(connId).id
  return {
    changesGetSettings: () => h.settings(),
    changesSaveSettings: (p) => h.saveSettings(p),
    changesStats: () => h.stats(),
    changesBatches: (connId, q) => h.batches(configId(connId), q),
    changesRecords: (connId, batchId, q) => h.records(configId(connId), batchId, q),
    changesDetail: (connId, id) => restorer.detail(connId, id),
    changesRestorePlan: (connId, sel) => restorer.plan(connId, sel),
    changesRestore: (connId, sel, force) => restorer.restore(connId, sel, force),
    changesPurge: (connId, req) => h.purge(configId(connId), req)
  }
}

export { ChangeHistory } from './store'
export type { ChangeRecorders, ConnRecorder, ChangeBatch } from './recorder'
