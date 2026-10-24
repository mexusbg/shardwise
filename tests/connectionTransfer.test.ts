import { describe, expect, it } from 'vitest'
import { exportConnections, parseConnectionImport } from '../src/main/connectionTransfer'
import { newConnectionConfig } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'

const conn = (p: Partial<ConnectionConfig>): ConnectionConfig => ({ ...newConnectionConfig(), id: 'x', ...p })

const sample = [
  conn({ name: 'Atlas', mode: 'srv', srvHost: 'c0.example.net', auth: { mechanism: 'DEFAULT', username: 'u', password: 'p@ss', authSource: 'admin' }, tls: { enabled: true } }),
  conn({ name: 'Local', ssh: { enabled: true, host: 'bastion', port: 22, username: 'me', method: 'password', password: 'sshpw' } })
]

describe('connection export / import', () => {
  it('round-trips without passwords', () => {
    const text = exportConnections(sample, { format: 'shardwise', includePasswords: false })
    expect(text).not.toContain('p@ss')
    expect(text).not.toContain('sshpw')
    const r = parseConnectionImport(text)
    expect(r.format).toBe('Shardwise')
    expect(r.connections.map((c) => c.name)).toEqual(['Atlas', 'Local'])
    expect(r.connections[0].auth.password).toBeUndefined()
    expect(r.connections[0].id).toBe('')
  })

  it('round-trips passwords encrypted with a passphrase', () => {
    const text = exportConnections(sample, { format: 'shardwise', includePasswords: true, passphrase: 'secret phrase' })
    expect(text).not.toContain('p@ss')
    const locked = parseConnectionImport(text)
    expect(locked.needsPassphrase).toBe(true)
    expect(() => parseConnectionImport(text, 'wrong')).toThrow('Wrong passphrase')
    const r = parseConnectionImport(text, 'secret phrase')
    expect(r.connections[0].auth.password).toBe('p@ss')
    expect(r.connections[1].ssh.password).toBe('sshpw')
  })

  it('exports and imports a URI list', () => {
    const text = exportConnections(sample, { format: 'uri', includePasswords: false })
    const r = parseConnectionImport(text)
    expect(r.format).toBe('URI list')
    expect(r.connections[0]).toMatchObject({ name: 'Atlas', mode: 'srv', srvHost: 'c0.example.net' })
    expect(r.connections[1].hosts[0].host).toBe('localhost')
  })

  it('imports MongoDB Compass exports', () => {
    const r = parseConnectionImport(
      JSON.stringify({
        type: 'Compass Connections',
        version: { $numberInt: '1' },
        connections: [
          { id: '1', connectionOptions: { connectionString: 'mongodb+srv://app@cluster0.x.mongodb.net/shop' }, favorite: { name: 'Prod' } },
          { id: '2', connectionOptions: { connectionString: 'mongodb://localhost:27017', sshTunnel: { host: 'jump', port: 2222, username: 'ops' } } }
        ]
      })
    )
    expect(r.format).toBe('MongoDB Compass')
    expect(r.connections[0]).toMatchObject({ name: 'Prod', mode: 'srv' })
    expect(r.connections[1].ssh).toMatchObject({ enabled: true, host: 'jump', port: 2222, username: 'ops' })
  })

  it('imports Robo 3T configs', () => {
    const r = parseConnectionImport(
      JSON.stringify({
        connections: [
          {
            connectionName: 'Robo',
            serverHost: 'db.local',
            serverPort: 27018,
            credentials: [{ enabled: true, userName: 'admin', userPassword: 'pw', databaseName: 'admin', mechanism: 'SCRAM-SHA-256' }],
            ssl: { enabled: true, allowInvalidHostnames: true },
            ssh: { enabled: false }
          }
        ]
      })
    )
    expect(r.format).toBe('Robo 3T')
    expect(r.connections[0]).toMatchObject({ name: 'Robo', hosts: [{ host: 'db.local', port: 27018 }] })
    expect(r.connections[0].auth).toMatchObject({ mechanism: 'SCRAM-SHA-256', username: 'admin', password: 'pw' })
    expect(r.connections[0].tls).toMatchObject({ enabled: true, allowInvalidHostnames: true })
  })

  it('imports Studio 3T style exports with comment headers', () => {
    const text = `// Connections Exported from Studio 3T --
// Exported on 21 Oct 2026 10:00
[
  { "name": "Studio prod", "connectionString": "mongodb+srv://u@cl.example.net/" },
  { "name": "Studio local", "serverList": [{ "host": "10.0.0.1", "port": 27017 }, { "host": "10.0.0.2", "port": 27017 }], "replicaSetName": "rs0", "userName": "me", "authDatabase": "admin" },
  { "name": "broken" }
]`
    const r = parseConnectionImport(text)
    expect(r.format).toBe('Studio 3T')
    expect(r.connections.map((c) => c.name)).toEqual(['Studio prod', 'Studio local'])
    expect(r.connections[1]).toMatchObject({ mode: 'replicaSet', replicaSet: 'rs0' })
    expect(r.connections[1].auth.username).toBe('me')
    expect(r.warnings.some((w) => w.includes('broken'))).toBe(true)
  })

  it('rejects garbage', () => {
    expect(() => parseConnectionImport('hello')).toThrow('Unrecognised')
  })
})
