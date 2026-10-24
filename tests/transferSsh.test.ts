import net from 'net'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Server } from 'ssh2'
import type { JobProgress } from '@shared/api'
import { newConnectionConfig } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { openSshTunnel } from '../src/main/mongo/sshTunnel'
import { ConnectionManager } from '../src/main/mongo/manager'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { Transfers } from '../src/main/transfer/jobs'
import { locateTools } from '../src/main/transfer/bsonTools'
import { ed25519HostKey } from './helpers/sshHostKey'

const TOOLS_PATH = process.env.MONGO_TOOLS_PATH ?? ''
const toolsFound = !!(await locateTools(TOOLS_PATH, join(tmpdir(), 'shardwise-no-tools')))

let mongo: MongoMemoryServer
let mongoPort = 0
let sshServer: Server
let sshPort = 0

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  mongoPort = Number(new URL(mongo.getUri()).port)
  const c = await MongoClient.connect(mongo.getUri())
  await c.db('shop').collection('items').insertMany([{ a: 1 }, { a: 2 }, { a: 3 }])
  await c.close()
  const hostKey = ed25519HostKey()
  sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    client
      .on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])))
      .on('ready', () => {
        client.on('tcpip', (accept, _reject, info) => {
          const stream = accept()
          const sock = net.connect(info.destPort, info.destIP)
          stream.pipe(sock).pipe(stream)
          sock.on('error', () => stream.destroy())
          stream.on('error', () => sock.destroy())
        })
      })
      .on('error', () => {})
  })
  await new Promise<void>((r) => sshServer.listen(0, '127.0.0.1', () => r()))
  sshPort = (sshServer.address() as net.AddressInfo).port
})

afterAll(async () => {
  sshServer?.close()
  await mongo?.stop()
})

const sshCfg = { enabled: true, host: '127.0.0.1', port: 0, username: 'tester', method: 'password' as const, password: 'secret' }

describe('SSH port forward for external tools', () => {
  const refused = (port: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s))
      s.on('error', reject)
    })

  it('forwards a local TCP port through the SSH connection', async () => {
    const tunnel = await openSshTunnel({ ...sshCfg, port: sshPort })
    const { port: local } = await tunnel.forwardPort('127.0.0.1', mongoPort)
    expect(local).toBeGreaterThan(0)
    const c = await MongoClient.connect(`mongodb://127.0.0.1:${local}/?directConnection=true`)
    expect((await c.db('shop').collection('items').countDocuments())).toBe(3)
    await c.close()
    await tunnel.close()
    // The listener is closed together with the tunnel.
    await expect(refused(local)).rejects.toThrow()
  })

  it('closes a single port forward without closing the tunnel', async () => {
    const tunnel = await openSshTunnel({ ...sshCfg, port: sshPort })
    const a = await tunnel.forwardPort('127.0.0.1', mongoPort)
    const b = await tunnel.forwardPort('127.0.0.1', mongoPort)
    const c = await MongoClient.connect(`mongodb://127.0.0.1:${a.port}/?directConnection=true&serverSelectionTimeoutMS=1000`)
    a.close()
    await expect(refused(a.port)).rejects.toThrow()
    // Open connections through the closed forward are dropped too.
    await expect(c.db('shop').collection('items').countDocuments({}, { maxTimeMS: 2000 })).rejects.toThrow()
    await c.close().catch(() => {})
    const d = await MongoClient.connect(`mongodb://127.0.0.1:${b.port}/?directConnection=true`)
    expect(await d.db('shop').collection('items').countDocuments()).toBe(3)
    await d.close()
    b.close()
    await tunnel.close()
  })

  it.skipIf(!toolsFound)(`runs mongodump through the SSH tunnel${toolsFound ? '' : ' (skipped: MongoDB Database Tools not found)'}`, async () => {
    const mgr = new ConnectionManager()
    const cfg: ConnectionConfig = {
      ...newConnectionConfig(),
      hosts: [{ host: '127.0.0.1', port: mongoPort }],
      ssh: { ...sshCfg, port: sshPort }
    }
    const { connId } = await mgr.connect(cfg)
    const dir = await fs.mkdtemp(join(tmpdir(), 'shardwise-ssh-'))
    const finals = new Map<string, (p: JobProgress) => void>()
    const t = new Transfers(mgr, { getSettings: async () => ({ ...DEFAULT_SETTINGS, toolsPath: TOOLS_PATH }) }, dir, (p) => {
      if (p.state !== 'running') finals.get(p.jobId)?.(p)
    })
    const id = t.startExport({ connId, db: 'shop', collections: ['items'], format: 'bson-archive', target: join(dir, 'items.archive') })
    const p = await new Promise<JobProgress>((r) => finals.set(id, r))
    expect(p.state).toBe('done')
    expect(p.done).toBe(3)
    expect(p.log?.[0]).toMatch(/SSH port forward 127\.0\.0\.1:\d+ → 127\.0\.0\.1:\d+/)
    // The job's port forward is closed when it finishes.
    await expect(refused(Number(/127\.0\.0\.1:(\d+)/.exec(p.log![0])![1]))).rejects.toThrow()
    await mgr.closeAll()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
