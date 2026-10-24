import type { Document, MongoClient } from 'mongodb'
import type { Doc, IndexDetail } from '@shared/api'
import { indexType } from '@shared/indexForm'

const codeName = (e: unknown): string | undefined => (e as { codeName?: string }).codeName

/** Index sizes in bytes, summed over shards. */
async function indexSizes(client: MongoClient, db: string, coll: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const add = (sizes: unknown): void => {
    for (const [k, v] of Object.entries((sizes ?? {}) as Doc)) out[k] = (out[k] ?? 0) + Number(v)
  }
  try {
    const docs = await client.db(db).collection(coll).aggregate([{ $collStats: { storageStats: {} } }]).toArray()
    for (const d of docs) add((d.storageStats as Doc | undefined)?.indexSizes)
    return out
  } catch {
    try {
      const r = await client.db(db).command({ collStats: coll })
      add(r.indexSizes)
    } catch {
      // views, missing privileges
    }
    return out
  }
}

/** $indexStats usage: ops summed over hosts, earliest `since`. */
async function indexUsage(client: MongoClient, db: string, coll: string): Promise<Map<string, { ops: number; since?: Date }>> {
  const out = new Map<string, { ops: number; since?: Date }>()
  try {
    const docs = await client.db(db).collection(coll).aggregate([{ $indexStats: {} }]).toArray()
    for (const d of docs) {
      const acc = (d.accesses ?? {}) as { ops?: unknown; since?: Date }
      const prev = out.get(d.name)
      const ops = Number(acc.ops ?? 0) + (prev?.ops ?? 0)
      const since = prev?.since && acc.since ? (prev.since < acc.since ? prev.since : acc.since) : (prev?.since ?? acc.since)
      out.set(d.name, { ops, since })
    }
  } catch {
    // views, missing privileges, old servers
  }
  return out
}

interface Build {
  spec: Doc
  progress: number
}

/** Index builds in progress on the collection, from $currentOp. */
async function indexBuilds(client: MongoClient, db: string, coll: string): Promise<Build[]> {
  const match = { 'command.createIndexes': coll, $or: [{ 'command.$db': db }, { ns: `${db}.${coll}` }] }
  let ops: Document[] = []
  for (const allUsers of [true, false]) {
    try {
      ops = await client
        .db('admin')
        .aggregate([{ $currentOp: { allUsers, idleConnections: false } }, { $match: match }])
        .toArray()
      break
    } catch {
      // retry without allUsers, then give up
    }
  }
  const builds = new Map<string, Build>()
  for (const op of ops) {
    const p = op.progress as { done?: unknown; total?: unknown } | undefined
    const done = Number(p?.done ?? 0)
    const total = Number(p?.total ?? 0)
    let pct = total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 0
    if (!total && typeof op.msg === 'string') {
      const m = /(\d+(?:\.\d+)?)%/.exec(op.msg)
      if (m) pct = Number(m[1])
    }
    for (const spec of ((op.command as Doc).indexes ?? []) as Doc[]) {
      const name = String(spec.name)
      const prev = builds.get(name)
      if (!prev || pct > prev.progress) builds.set(name, { spec, progress: pct })
    }
  }
  return [...builds.values()]
}

/** listIndexes merged with sizes, usage statistics and in-progress builds. */
export async function indexDetails(client: MongoClient, db: string, coll: string): Promise<IndexDetail[]> {
  let specs: Document[]
  try {
    specs = await client.db(db).collection(coll).listIndexes().toArray()
  } catch (e) {
    if (codeName(e) === 'NamespaceNotFound') return []
    throw e
  }
  const [sizes, usage, builds] = await Promise.all([indexSizes(client, db, coll), indexUsage(client, db, coll), indexBuilds(client, db, coll)])
  const list: IndexDetail[] = specs.map((s) => {
    const spec = s as Doc & { name: string; key: Doc }
    const u = usage.get(spec.name)
    const d: IndexDetail = { ...spec, type: indexType(spec) }
    if (sizes[spec.name] != null) d.size = sizes[spec.name]
    if (u) {
      d.ops = u.ops
      if (u.since) d.since = u.since
    }
    const b = builds.find((x) => x.spec.name === spec.name)
    if (b) d.building = b.progress
    return d
  })
  for (const b of builds) {
    if (list.some((x) => x.name === b.spec.name)) continue
    const spec = { ...b.spec, name: String(b.spec.name), key: (b.spec.key ?? {}) as Doc }
    list.push({ ...spec, type: indexType(spec), building: b.progress, size: sizes[spec.name] })
  }
  return list
}

export async function dropIndex(client: MongoClient, db: string, coll: string, name: string): Promise<void> {
  if (name === '_id_') throw new Error('The _id index cannot be dropped')
  await client.db(db).collection(coll).dropIndex(name)
}

export async function setIndexHidden(client: MongoClient, db: string, coll: string, name: string, hidden: boolean): Promise<void> {
  if (name === '_id_') throw new Error('The _id index cannot be hidden')
  await client.db(db).command({ collMod: coll, index: { name, hidden } })
}
