import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { newConnectionConfig } from '@shared/connection'

const codec = {
  encrypt: async (s: string) => Buffer.from(s).toString('base64'),
  decrypt: async (s: string) => Buffer.from(s, 'base64').toString()
}
const q = (query: string) => ({ query, projection: '', sort: '{ _id: -1 }', skip: '', limit: '100' })

describe('Store', () => {
  it('encrypts secrets at rest and reveals them on read', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-store-')), 'shardwise.json')
    const store = new Store(file, codec)
    const c = await store.saveConnection({ ...newConnectionConfig(), auth: { mechanism: 'DEFAULT', username: 'u', password: 'p@ss' } })
    expect(readFileSync(file, 'utf8')).not.toContain('p@ss')
    const back = await new Store(file, codec).getConnection(c.id)
    expect(back.auth.password).toBe('p@ss')
  })

  it('resolves the most specific default query', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-store-')), 'shardwise.json')
    const store = new Store(file, codec)
    expect(await store.getDefaultQuery('c1', 'shop', 'orders')).toBeNull()
    await store.setDefaultQuery('c1', 'connection', 'shop', 'orders', q('{ a: 1 }'))
    await store.setDefaultQuery('c1', 'database', 'shop', 'orders', q('{ b: 1 }'))
    expect(await store.getDefaultQuery('c1', 'shop', 'orders')).toMatchObject({ scope: 'database', value: { query: '{ b: 1 }' } })
    expect(await store.getDefaultQuery('c1', 'other', 'x')).toMatchObject({ scope: 'connection' })
    await store.setDefaultQuery('c1', 'collection', 'shop', 'orders', q('{ c: 1 }'))
    expect((await store.getDefaultQuery('c1', 'shop', 'orders'))?.scope).toBe('collection')
    expect(await store.listDefaultQueries('c1', 'shop', 'orders')).toEqual(['collection', 'database', 'connection'])
    await store.setDefaultQuery('c1', 'collection', 'shop', 'orders', null)
    expect((await new Store(file, codec).getDefaultQuery('c1', 'shop', 'orders'))?.scope).toBe('database')
  })

  it('drops default queries with their connection', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-store-')), 'shardwise.json')
    const store = new Store(file, codec)
    const c = await store.saveConnection(newConnectionConfig())
    await store.setDefaultQuery(c.id, 'database', 'shop', '', q('{}'))
    await store.deleteConnection(c.id)
    expect(await store.getDefaultQuery(c.id, 'shop', 'x')).toBeNull()
  })
})

describe('raw URI secrets', () => {
  it('encrypts a connection string that contains a password', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-store-')), 'shardwise.json')
    const store = new Store(file, codec)
    const c = await store.saveConnection({ ...newConnectionConfig(), mode: 'uri', uri: 'mongodb://admin:S3cret@db/' })
    expect(readFileSync(file, 'utf8')).not.toContain('S3cret')
    expect((await new Store(file, codec).getConnection(c.id)).uri).toBe('mongodb://admin:S3cret@db/')
  })
})

describe('app secrets', () => {
  it('survive a restart and later saves', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-store-')), 'shardwise.json')
    await new Store(file, codec).setSecret('anthropicApiKey', 'sk-ant-test')
    const reopened = new Store(file, codec)
    expect(await reopened.getSecret('anthropicApiKey')).toBe('sk-ant-test')
    await reopened.saveSettings({ pageSize: 100 })
    expect(await new Store(file, codec).getSecret('anthropicApiKey')).toBe('sk-ant-test')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-test')
  })
})

describe('session', () => {
  it('persists the open tabs across restarts', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-store-')), 'shardwise.json')
    const session = {
      savedAt: new Date('2026-10-21T10:00:00Z'),
      active: 0,
      tabs: [{ kind: 'query' as const, configId: 'c1', db: 'shop', coll: 'orders', isView: false, query: { query: '{ a: 1 }', projection: '', sort: '', skip: '', limit: '' }, view: 'table' as const, pageSize: 50 }]
    }
    await new Store(file, codec).saveSession(session)
    const back = await new Store(file, codec).getSession()
    expect(back?.tabs[0]).toMatchObject({ coll: 'orders', query: { query: '{ a: 1 }' } })
    expect(back?.savedAt).toBeInstanceOf(Date)
    expect((await new Store(file, codec).getSettings()).restoreSession).toBe('ask')
  })
})
