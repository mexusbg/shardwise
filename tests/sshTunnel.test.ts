import net from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Server } from 'ssh2'
import { clientOptions, ConnectionManager } from '../src/main/mongo/manager'
import { openSshTunnel } from '../src/main/mongo/sshTunnel'
import { newConnectionConfig } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { ed25519HostKey } from './helpers/sshHostKey'

let mongo: MongoMemoryServer
let sshServer: Server
let sshPort = 0
let forwards = 0

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  const hostKey = ed25519HostKey()
  sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    client
      .on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret') ctx.accept()
        else ctx.reject(['password'])
      })
      .on('ready', () => {
        client.on('tcpip', (accept, _reject, info) => {
          forwards++
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

const cfgVia = (password: string): ConnectionConfig => {
  const port = Number(new URL(mongo.getUri()).port)
  return {
    ...newConnectionConfig(),
    hosts: [{ host: 'localhost', port }],
    directConnection: true,
    ssh: { enabled: true, host: '127.0.0.1', port: sshPort, username: 'tester', method: 'password', password }
  }
}

describe('SSH tunnel', () => {
  it('connects to MongoDB through the SOCKS-over-SSH tunnel', async () => {
    const mgr = new ConnectionManager()
    const before = forwards
    const t = await mgr.test(cfgVia('secret'))
    expect(t.ok).toBe(true)
    expect(t.steps[0]).toMatchObject({ name: 'SSH tunnel', ok: true })
    expect(forwards).toBeGreaterThan(before)

    const c = await mgr.connect(cfgVia('secret'))
    const res = await mgr.get(c.connId).db('admin').command({ ping: 1 })
    expect(res.ok).toBe(1)
    await mgr.closeAll()
  })

  it('reports bad SSH credentials', async () => {
    const t = await new ConnectionManager().test(cfgVia('wrong'))
    expect(t.ok).toBe(false)
    expect(t.steps[0]).toMatchObject({ name: 'SSH tunnel', ok: false })
  })

  it('requires the per-tunnel SOCKS5 credentials', async () => {
    const cfg = cfgVia('secret')
    const tunnel = await openSshTunnel(cfg.ssh)
    const port = Number(new URL(mongo.getUri()).port)
    expect(tunnel.username).toMatch(/^[0-9a-f]{24}$/)
    expect(tunnel.password).toMatch(/^[0-9a-f]{48}$/)
    expect(clientOptions(cfg, tunnel)).toMatchObject({
      proxyHost: '127.0.0.1',
      proxyPort: tunnel.port,
      proxyUsername: tunnel.username,
      proxyPassword: tunnel.password
    })

    // Raw SOCKS5 exchange: returns the bytes the proxy sent back before closing.
    const exchange = (...frames: Buffer[]): Promise<Buffer> =>
      new Promise((resolve) => {
        const s = net.connect(tunnel.port, '127.0.0.1')
        let got = Buffer.alloc(0)
        let i = 0
        s.on('connect', () => s.write(frames[i++]))
        s.on('data', (d) => {
          got = Buffer.concat([got, d])
          if (i < frames.length) s.write(frames[i++])
        })
        s.on('close', () => resolve(got))
        s.on('error', () => resolve(got))
        setTimeout(() => {
          s.destroy()
          resolve(got)
        }, 2000)
      })
    const connect = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff])
    const auth = (u: string, p: string): Buffer => Buffer.concat([Buffer.from([1, u.length]), Buffer.from(u), Buffer.from([p.length]), Buffer.from(p)])

    const before = forwards
    // No-auth only: no acceptable method.
    expect([...(await exchange(Buffer.from([5, 1, 0]), connect))]).toEqual([5, 0xff])
    // Wrong password: auth failure, connection closed.
    expect([...(await exchange(Buffer.from([5, 2, 0, 2]), auth(tunnel.username, 'nope'), connect))]).toEqual([5, 2, 1, 1])
    expect(forwards).toBe(before)
    // Right credentials: CONNECT succeeds.
    const ok = await exchange(Buffer.from([5, 1, 2]), auth(tunnel.username, tunnel.password), connect)
    expect([...ok.subarray(0, 6)]).toEqual([5, 2, 1, 0, 5, 0])
    expect(forwards).toBe(before + 1)

    // The driver authenticates with the credentials from clientOptions.
    const { MongoClient } = await import('mongodb')
    const c = new MongoClient(`mongodb://localhost:${port}/?directConnection=true`, clientOptions(cfg, tunnel))
    expect((await c.db('admin').command({ ping: 1 })).ok).toBe(1)
    await c.close()
    const bad = new MongoClient(`mongodb://localhost:${port}/?directConnection=true`, {
      ...clientOptions(cfg, tunnel),
      proxyPassword: 'wrong',
      serverSelectionTimeoutMS: 1500
    })
    await expect(bad.db('admin').command({ ping: 1 })).rejects.toThrow()
    await bad.close()
    await tunnel.close()
  })
})
