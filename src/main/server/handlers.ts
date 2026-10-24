import type { ServerApi } from '@shared/serverApi'
import type { ConnectionManager } from '../mongo/manager'
import * as status from './status'
import * as validation from './validation'

type Handlers = { [K in keyof ServerApi]: (...args: Parameters<ServerApi[K]>) => Promise<ReturnType<ServerApi[K]>> | ReturnType<ServerApi[K]> }

export function serverHandlers(mgr: ConnectionManager): Handlers {
  return {
    serverInfo: (connId) => status.serverInfo(mgr.get(connId)),
    serverSample: (connId) => status.serverSample(mgr.get(connId)),
    serverReplication: (connId) => status.replication(mgr.get(connId)),
    serverSharding: (connId) => status.sharding(mgr.get(connId)),
    serverDbStats: (connId) => status.dbStats(mgr.get(connId)),

    validationGet: (connId, db, coll) => validation.getValidation(mgr.get(connId), db, coll),
    validationSet: (connId, db, coll, rules) => validation.setValidation(mgr.get(connId), db, coll, rules),
    validationTest: (connId, db, coll, validator, sample) => validation.testValidation(mgr.get(connId), db, coll, validator, sample),

    viewGet: (connId, db, name) => validation.getView(mgr.get(connId), db, name),
    viewUpdate: (connId, db, name, viewOn, pipeline) => validation.updateView(mgr.get(connId), db, name, viewOn, pipeline)
  }
}
