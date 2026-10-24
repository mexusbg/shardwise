import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import * as users from '../src/main/mongo/users'

let server: MongoMemoryServer
let client: MongoClient
const DB = 'usersdb'
const SECRET = 'S3cret-pa55word!'

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client.db(DB).collection('things').insertOne({ a: 1 })
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

describe('users', () => {
  it('creates and lists users without leaking credentials', async () => {
    await users.createUser(client, DB, 'alice', SECRET, [{ role: 'read', db: DB }], { team: 'ops' })
    await users.createUser(client, DB, 'bob', SECRET, [
      { role: 'readWrite', db: DB },
      { role: 'clusterMonitor', db: 'admin' }
    ])
    const list = await users.listUsers(client, DB)
    expect(list.map((u) => u.user)).toEqual(['alice', 'bob'])
    const alice = list[0]
    expect(alice.db).toBe(DB)
    expect(alice.roles).toEqual([{ role: 'read', db: DB }])
    expect(alice.customData).toEqual({ team: 'ops' })
    expect(alice.mechanisms?.length).toBeGreaterThan(0)
    expect(list[1].roles).toEqual(expect.arrayContaining([{ role: 'readWrite', db: DB }, { role: 'clusterMonitor', db: 'admin' }]))
    const raw = JSON.stringify(list)
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toMatch(/credentials|storedKey|serverKey|salt|pwd/i)
    for (const u of list) expect(Object.keys(u).sort()).toEqual(expect.arrayContaining(['db', 'roles', 'user']))
  })

  it('updates roles, password and customData', async () => {
    await users.updateUser(client, DB, 'alice', { roles: [{ role: 'readWrite', db: DB }], customData: { team: 'dev' } })
    await users.updateUser(client, DB, 'alice', { password: 'An0ther-secret' })
    await users.updateUser(client, DB, 'alice', {})
    const alice = (await users.listUsers(client, DB)).find((u) => u.user === 'alice')
    expect(alice?.roles).toEqual([{ role: 'readWrite', db: DB }])
    expect(alice?.customData).toEqual({ team: 'dev' })
    expect(JSON.stringify(alice)).not.toContain('An0ther-secret')
  })

  it('drops users', async () => {
    await users.dropUser(client, DB, 'bob')
    expect((await users.listUsers(client, DB)).map((u) => u.user)).toEqual(['alice'])
    await expect(users.dropUser(client, DB, 'nobody')).rejects.toThrow()
  })

  it('rejects duplicates', async () => {
    await expect(users.createUser(client, DB, 'alice', SECRET, [])).rejects.toThrow(/already exists/)
  })
})

describe('roles', () => {
  it('creates custom roles with privileges and inherited roles', async () => {
    await users.createRole(client, DB, 'reporter', [{ resource: { db: DB, collection: 'things' }, actions: ['find', 'listIndexes'] }], [{ role: 'read', db: DB }])
    await users.createRole(client, DB, 'auditor', [{ resource: { db: DB, collection: '' }, actions: ['collStats', 'dbStats'] }], [{ role: 'reporter', db: DB }])
    const roles = await users.listRoles(client, DB, false)
    expect(roles.map((r) => r.role)).toEqual(['auditor', 'reporter'])
    expect(roles.every((r) => !r.isBuiltin)).toBe(true)
    const reporter = roles.find((r) => r.role === 'reporter')!
    expect(reporter.roles).toEqual([{ role: 'read', db: DB }])
    expect(reporter.privileges).toEqual(
      expect.arrayContaining([{ resource: { db: DB, collection: 'things' }, actions: expect.arrayContaining(['find', 'listIndexes']) }])
    )
    const auditor = roles.find((r) => r.role === 'auditor')!
    expect(auditor.inheritedRoles).toEqual(expect.arrayContaining([{ role: 'reporter', db: DB }, { role: 'read', db: DB }]))
  })

  it('lists built-in roles on request', async () => {
    const roles = await users.listRoles(client, DB, true)
    const builtin = roles.filter((r) => r.isBuiltin).map((r) => r.role)
    expect(builtin).toEqual(expect.arrayContaining(['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin']))
    expect(roles.filter((r) => !r.isBuiltin).map((r) => r.role)).toEqual(['auditor', 'reporter'])
    expect(roles.findIndex((r) => r.isBuiltin)).toBeGreaterThan(roles.findIndex((r) => r.role === 'reporter'))
    const admin = (await users.listRoles(client, 'admin', true)).map((r) => r.role)
    expect(admin).toEqual(expect.arrayContaining(['root', 'clusterAdmin', 'readAnyDatabase']))
  })

  it('updates and drops roles', async () => {
    await users.updateRole(client, DB, 'reporter', [{ resource: { db: DB, collection: 'other' }, actions: ['insert'] }], [])
    const reporter = (await users.listRoles(client, DB, false)).find((r) => r.role === 'reporter')!
    expect(reporter.roles).toEqual([])
    expect(reporter.privileges).toEqual([{ resource: { db: DB, collection: 'other' }, actions: ['insert'] }])
    await users.dropRole(client, DB, 'auditor')
    await users.dropRole(client, DB, 'reporter')
    expect(await users.listRoles(client, DB, false)).toEqual([])
  })

  it('supports cluster privileges on admin roles', async () => {
    await users.createRole(client, 'admin', 'statusWatcher', [{ resource: { cluster: true }, actions: ['serverStatus'] }], [])
    const r = (await users.listRoles(client, 'admin', false)).find((x) => x.role === 'statusWatcher')!
    expect(r.privileges).toEqual([{ resource: { cluster: true }, actions: ['serverStatus'] }])
    await users.dropRole(client, 'admin', 'statusWatcher')
  })
})
