import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { newConnectionConfig, parseUri } from '@shared/connection'
import type { ConnectStep } from '@shared/api'
import { ConnectCancelled, ConnectionManager, describeServers } from '../src/main/mongo/manager'

let server: MongoMemoryServer

beforeAll(async () => {
  server = await MongoMemoryServer.create()
}, 120000)

afterAll(async () => {
  await server?.stop()
})

describe('connect progress', () => {
  it('reports each stage as it starts and ends', async () => {
    const mgr = new ConnectionManager()
    const steps: ConnectStep[] = []
    const cfg = parseUri(server.getUri(), newConnectionConfig())
    const r = await mgr.connect(cfg, { progress: (s) => steps.push(s) })
    await mgr.disconnect(r.connId)
    expect(steps.map((s) => `${s.name}:${s.state}`)).toEqual(['Connect:running', 'Connect:ok', 'Server info:running', 'Server info:ok'])
    expect(steps[0].detail).toMatch(/:\d+$/)
    expect(steps[3].detail).toContain('MongoDB')
  })

  it('stops an attempt that is still waiting for the server', async () => {
    const mgr = new ConnectionManager()
    const steps: ConnectStep[] = []
    const ctl = new AbortController()
    const cfg = { ...newConnectionConfig(), hosts: [{ host: '127.0.0.1', port: 1 }], options: { serverSelectionTimeoutMS: 20000 } }
    const started = Date.now()
    setTimeout(() => ctl.abort(), 200)
    await expect(mgr.connect(cfg, { progress: (s) => steps.push(s), signal: ctl.signal })).rejects.toBeInstanceOf(ConnectCancelled)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(steps.at(-1)).toMatchObject({ name: 'Connect', state: 'failed', detail: 'Cancelled' })
    expect(mgr.liveConnections()).toEqual([])
  })

  it('does not start when cancelled before it begins', async () => {
    const mgr = new ConnectionManager()
    const ctl = new AbortController()
    ctl.abort()
    const cfg = parseUri(server.getUri(), newConnectionConfig())
    await expect(mgr.connect(cfg, { signal: ctl.signal })).rejects.toBeInstanceOf(ConnectCancelled)
    expect(mgr.liveConnections()).toEqual([])
  })

  it('names the servers being contacted', () => {
    const base = newConnectionConfig()
    expect(describeServers({ ...base, mode: 'srv', srvHost: 'cluster0.example.net' })).toBe('cluster0.example.net (SRV)')
    const hosts = [1, 2, 3, 4, 5].map((i) => ({ host: `db${i}.example.net`, port: 27017 }))
    expect(describeServers({ ...base, mode: 'replicaSet', hosts })).toBe('db1.example.net:27017, db2.example.net:27017, db3.example.net:27017 +2 more')
    expect(describeServers({ ...base, hosts: [{ host: '::1', port: 27018 }] })).toBe('[::1]:27018')
  })
})
