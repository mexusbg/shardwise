import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import type { Collection } from 'mongodb'
import * as validation from '../src/main/server/validation'
import { analyzeSchema, toJsonSchema } from '@shared/schema'

let server: MongoMemoryServer
let client: MongoClient
const DB = 'val'
type Person = { _id: number; name?: unknown; age?: unknown }
const people = (): Collection<Person> => client.db(DB).collection<Person>('people')

const schema = { $jsonSchema: { bsonType: 'object', required: ['name', 'age'], properties: { name: { bsonType: 'string' }, age: { bsonType: 'int', minimum: 0 } } } }

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  const coll = people()
  await coll.insertMany([
    ...Array.from({ length: 30 }, (_, i) => ({ _id: i, name: `p${i}`, age: i })),
    { _id: 100, name: 'no age' },
    { _id: 101, name: 7, age: 3 },
    { _id: 102, age: -1, name: 'negative' }
  ])
  await client.db(DB).createCollection('plain')
  await client.db(DB).createCollection('adults', { viewOn: 'people', pipeline: [{ $match: { age: { $gte: 18 } } }] })
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

describe('validation rules', () => {
  it('reads a collection without validation', async () => {
    const v = await validation.getValidation(client, DB, 'plain')
    expect(v).toMatchObject({ validator: null, level: 'strict', action: 'error' })
    expect(v.serverVersion).toMatch(/^\d+\./)
    expect(v.actions).toContain('warn')
  })

  it('sets and reads validator, level and action', async () => {
    const r = await validation.setValidation(client, DB, 'people', { validator: schema, level: 'moderate', action: 'warn' })
    expect(r.level).toBe('moderate')
    expect(r.action).toBe('warn')
    expect(JSON.parse(JSON.stringify(r.validator))).toEqual(JSON.parse(JSON.stringify(schema)))
    const again = await validation.getValidation(client, DB, 'people')
    expect(again.level).toBe('moderate')
    const info = await client.db(DB).listCollections({ name: 'people' }).toArray()
    expect((info[0] as { options?: unknown }).options).toMatchObject({ validationLevel: 'moderate', validationAction: 'warn' })
  })

  it('enforces strict / error', async () => {
    await validation.setValidation(client, DB, 'people', { validator: schema, level: 'strict', action: 'error' })
    await expect(client.db(DB).collection('people').insertOne({ name: 'bad' })).rejects.toThrow(/validation/i)
    await people().insertOne({ _id: 200, name: 'ok', age: 40 })
  })

  it('supports query-operator validators and level off', async () => {
    const r = await validation.setValidation(client, DB, 'plain', { validator: { qty: { $gte: 0 } }, level: 'off', action: 'error' })
    expect(r.level).toBe('off')
    await client.db(DB).collection('plain').insertOne({ qty: -5 })
  })

  it('supports errorAndLog when the server does', async () => {
    const v = await validation.getValidation(client, DB, 'plain')
    if (!v.actions.includes('errorAndLog')) return
    const r = await validation.setValidation(client, DB, 'plain', { validator: { qty: { $gte: 0 } }, level: 'strict', action: 'errorAndLog' })
    expect(r.action).toBe('errorAndLog')
  })

  it('rejects bad levels and actions', async () => {
    await expect(validation.setValidation(client, DB, 'plain', { validator: null, level: 'loose' as never, action: 'error' })).rejects.toThrow(/level/)
    await expect(validation.setValidation(client, DB, 'plain', { validator: null, level: 'strict', action: 'explode' as never })).rejects.toThrow(/action/)
  })

  it('removes validation', async () => {
    const r = await validation.setValidation(client, DB, 'plain', { validator: null, level: 'strict', action: 'error' })
    expect(r.validator).toBeNull()
    await client.db(DB).collection('plain').insertOne({ qty: -1 })
  })

  it('tests a validator against all documents', async () => {
    const r = await validation.testValidation(client, DB, 'people', schema, 0)
    expect(r.sampled).toBe(34)
    expect(r.failed).toBe(3)
    expect(r.passed).toBe(31)
    expect(r.failures.map((d) => Number(d._id)).sort()).toEqual([100, 101, 102])
    expect(r.total).toBe(34)
  })

  it('tests a sample and caps failing documents at 20', async () => {
    const r = await validation.testValidation(client, DB, 'people', { age: { $gte: 1000 } }, 10)
    expect(r.sampled).toBe(10)
    expect(r.failed).toBe(10)
    expect(r.failures).toHaveLength(10)
    const all = await validation.testValidation(client, DB, 'people', { age: { $gte: 1000 } }, 1000)
    expect(all.failed).toBe(34)
    expect(all.failures).toHaveLength(20)
    const none = await validation.testValidation(client, DB, 'people', {}, 0)
    expect(none.failed).toBe(0)
  })

  it('tests a validator generated from the schema of a sample', async () => {
    const docs = await people().find({ _id: { $lt: 30 } }).toArray()
    const generated = { $jsonSchema: toJsonSchema(analyzeSchema(docs)) }
    const r = await validation.testValidation(client, DB, 'people', generated, 0)
    expect(r.failed).toBe(2)
    await expect(validation.testValidation(client, DB, 'people', { $jsonSchema: { bsonType: 'nope' } }, 0)).rejects.toThrow()
  })

  it('refuses views', async () => {
    await expect(validation.getValidation(client, DB, 'adults')).rejects.toThrow(/view/)
    await expect(validation.getValidation(client, DB, 'missing')).rejects.toThrow(/does not exist/)
  })
})
