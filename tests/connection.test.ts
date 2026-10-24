import { describe, expect, it } from 'vitest'
import { buildUri, newConnectionConfig, parseUri } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'

const cfg = (p: Partial<ConnectionConfig>): ConnectionConfig => ({ ...newConnectionConfig(), ...p })

describe('buildUri', () => {
  it('builds a plain standalone uri', () => {
    expect(buildUri(cfg({}))).toBe('mongodb://localhost:27017/')
  })

  it('builds an SRV uri with credentials but no password by default', () => {
    const c = cfg({
      mode: 'srv',
      srvHost: 'cluster0.abcde.mongodb.net',
      auth: { mechanism: 'DEFAULT', username: 'me@x', password: 'p@ss/word', authSource: 'admin' },
      options: { defaultDb: 'shop', appName: 'Shardwise' }
    })
    expect(buildUri(c)).toBe('mongodb+srv://me%40x@cluster0.abcde.mongodb.net/shop?authSource=admin&tls=false&appName=Shardwise')
    expect(buildUri(c, true)).toContain('me%40x:p%40ss%2Fword@')
  })

  it('builds replica set, TLS and mechanism options', () => {
    const c = cfg({
      mode: 'replicaSet',
      hosts: [
        { host: 'a', port: 27017 },
        { host: 'b', port: 27018 }
      ],
      replicaSet: 'rs0',
      auth: { mechanism: 'MONGODB-X509' },
      tls: { enabled: true, allowInvalidHostnames: true },
      options: { readPreference: 'secondaryPreferred', extra: 'w=majority' }
    })
    expect(buildUri(c)).toBe(
      'mongodb://a:27017,b:27018/?replicaSet=rs0&authMechanism=MONGODB-X509&authSource=%24external&tls=true&tlsAllowInvalidHostnames=true&readPreference=secondaryPreferred&w=majority'
    )
  })

  it('passes raw uri mode through', () => {
    expect(buildUri(cfg({ mode: 'uri', uri: 'mongodb://x/?a=1' }))).toBe('mongodb://x/?a=1')
  })
})

describe('parseUri', () => {
  it('parses an SRV uri with credentials', () => {
    const c = parseUri('mongodb+srv://user:p%40ss@cluster0.x.mongodb.net/shop?retryWrites=true&w=majority&appName=Foo')
    expect(c.mode).toBe('srv')
    expect(c.srvHost).toBe('cluster0.x.mongodb.net')
    expect(c.auth).toMatchObject({ mechanism: 'DEFAULT', username: 'user', password: 'p@ss', authSource: 'shop' })
    expect(c.tls.enabled).toBe(true)
    expect(c.options.defaultDb).toBe('shop')
    expect(c.options.appName).toBe('Foo')
    expect(c.options).toMatchObject({ retryWrites: true, writeConcern: { w: 'majority' } })
    expect(c.options.extra).toBeUndefined()
  })

  it('parses a replica set host list', () => {
    const c = parseUri('mongodb://h1:27017,h2:27018/?replicaSet=rs0&authSource=admin&tls=true&readPreference=secondary')
    expect(c.mode).toBe('replicaSet')
    expect(c.hosts).toEqual([
      { host: 'h1', port: 27017 },
      { host: 'h2', port: 27018 }
    ])
    expect(c.replicaSet).toBe('rs0')
    expect(c.tls.enabled).toBe(true)
    expect(c.options.readPreference).toBe('secondary')
  })

  it('parses a standalone without auth', () => {
    const c = parseUri('mongodb://localhost')
    expect(c.mode).toBe('standalone')
    expect(c.hosts).toEqual([{ host: 'localhost', port: 27017 }])
    expect(c.auth.mechanism).toBe('none')
  })

  it('round-trips through buildUri', () => {
    const uri = 'mongodb://u@a:1,b:2/db?replicaSet=rs&authMechanism=SCRAM-SHA-256&authSource=admin&tls=true'
    expect(buildUri(parseUri(uri))).toBe(uri)
  })

  it('rejects garbage', () => {
    expect(() => parseUri('http://x')).toThrow()
  })
})

describe('raw URI passwords', () => {
  it('strips the password unless asked for it', () => {
    const c = { ...newConnectionConfig(), mode: 'uri' as const, uri: 'mongodb://admin:S3cret@db:27017/?tls=true' }
    expect(buildUri(c)).toBe('mongodb://admin@db:27017/?tls=true')
    expect(buildUri(c, true)).toContain('S3cret')
  })
})

describe('Studio 3T connection strings pasted into the editor', () => {
  // Same shape as a Studio 3T "Copy URI" string; host, user and password are made up.
  const uri =
    'mongodb+srv://app:secret@cluster0.example.mongodb.net/admin?retryWrites=true&loadBalanced=false&replicaSet=atlas-abc-shard-0&readPreference=primary&srvServiceName=mongodb&connectTimeoutMS=10000&authSource=admin&authMechanism=SCRAM-SHA-1&3t.uriVersion=3&3t.connection.name=Billing&3t.databases=admin&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true&3t.sslTlsVersion=TLS'

  it('drops the 3t.* settings (the driver rejects them) and keeps the connection name', () => {
    const c = parseUri(uri)
    expect(c.options.extra).toBeUndefined()
    expect(c.name).toBe('Billing')
    expect([c.mode, c.srvHost, c.auth.username, c.auth.mechanism, c.options.connectTimeoutMS]).toEqual(['srv', 'cluster0.example.mongodb.net', 'app', 'SCRAM-SHA-1', 10000])
    expect(buildUri(c)).not.toMatch(/3t\.|srvServiceName/)
  })

  it('keeps the name of an existing connection and a custom SRV service name', () => {
    const c = parseUri(uri.replace('srvServiceName=mongodb', 'srvServiceName=custom'), { ...newConnectionConfig(), name: 'Mine' })
    expect(c.name).toBe('Mine')
    expect(c.options.extra).toBe('srvServiceName=custom')
  })

  it('connection strings saved before the fix connect too', () => {
    const c = cfg({ options: { extra: 'appname=x&3t.uriVersion=3&3t.sslTlsVersion=TLS' } })
    expect(buildUri(c)).toBe('mongodb://localhost:27017/?appname=x')
  })
})
