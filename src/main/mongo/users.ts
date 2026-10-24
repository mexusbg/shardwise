import type { Document, MongoClient } from 'mongodb'
import type { Doc, Privilege, RoleInfo, RoleRef, UserInfo } from '@shared/api'

const roleRefs = (v: unknown): RoleRef[] =>
  Array.isArray(v) ? v.map((r) => ({ role: String((r as Doc).role), db: String((r as Doc).db) })) : []

const privileges = (v: unknown): Privilege[] =>
  Array.isArray(v)
    ? v.map((p) => ({ resource: { ...((p as Doc).resource as Doc) }, actions: ((p as Doc).actions as unknown[] | undefined ?? []).map(String) }))
    : []

/** Rewrites authorization failures into something actionable; never echoes command arguments. */
async function run(client: MongoClient, db: string, cmd: Document): Promise<Document> {
  try {
    return await client.db(db).command(cmd)
  } catch (e) {
    const err = e as { code?: number; codeName?: string; message?: string }
    if (err.code === 13 || err.codeName === 'Unauthorized' || /not authorized|requires authentication/i.test(err.message ?? '')) {
      throw new Error(
        `Not authorized on "${db}": the connected user needs the userAdmin role on this database (or userAdminAnyDatabase / root on admin) to manage users and roles. (${err.message ?? 'Unauthorized'})`
      )
    }
    throw e
  }
}

export async function listUsers(client: MongoClient, db: string): Promise<UserInfo[]> {
  const r = await run(client, db, { usersInfo: 1, showCredentials: false, showCustomData: true })
  return ((r.users ?? []) as Doc[])
    .map((u) => {
      const out: UserInfo = { user: String(u.user), db: String(u.db), roles: roleRefs(u.roles) }
      if (Array.isArray(u.mechanisms)) out.mechanisms = u.mechanisms.map(String)
      if (u.customData && typeof u.customData === 'object') out.customData = u.customData as Doc
      return out
    })
    .sort((a, b) => a.user.localeCompare(b.user))
}

export async function listRoles(client: MongoClient, db: string, showBuiltin: boolean): Promise<RoleInfo[]> {
  const r = await run(client, db, { rolesInfo: 1, showPrivileges: true, showBuiltinRoles: showBuiltin })
  return ((r.roles ?? []) as Doc[])
    .map((x) => ({
      role: String(x.role),
      db: String(x.db),
      isBuiltin: !!x.isBuiltin,
      roles: roleRefs(x.roles),
      privileges: privileges(x.privileges),
      inheritedRoles: roleRefs(x.inheritedRoles)
    }))
    .sort((a, b) => Number(a.isBuiltin) - Number(b.isBuiltin) || a.role.localeCompare(b.role))
}

export async function createUser(client: MongoClient, db: string, user: string, password: string, roles: RoleRef[], customData?: Doc): Promise<void> {
  const cmd: Document = { createUser: user, pwd: password, roles: roles.map(({ role, db }) => ({ role, db })) }
  if (customData) cmd.customData = customData
  await run(client, db, cmd)
}

export async function updateUser(client: MongoClient, db: string, user: string, changes: { password?: string; roles?: RoleRef[]; customData?: Doc }): Promise<void> {
  const cmd: Document = { updateUser: user }
  if (changes.password) cmd.pwd = changes.password
  if (changes.roles) cmd.roles = changes.roles.map(({ role, db }) => ({ role, db }))
  if (changes.customData) cmd.customData = changes.customData
  if (Object.keys(cmd).length === 1) return
  await run(client, db, cmd)
}

export async function dropUser(client: MongoClient, db: string, user: string): Promise<void> {
  await run(client, db, { dropUser: user })
}

const privilegeDocs = (list: Privilege[]): Document[] => list.map((p) => ({ resource: p.resource, actions: p.actions }))

export async function createRole(client: MongoClient, db: string, role: string, privs: Privilege[], roles: RoleRef[]): Promise<void> {
  await run(client, db, { createRole: role, privileges: privilegeDocs(privs), roles: roles.map(({ role, db }) => ({ role, db })) })
}

export async function updateRole(client: MongoClient, db: string, role: string, privs: Privilege[], roles: RoleRef[]): Promise<void> {
  await run(client, db, { updateRole: role, privileges: privilegeDocs(privs), roles: roles.map(({ role, db }) => ({ role, db })) })
}

export async function dropRole(client: MongoClient, db: string, role: string): Promise<void> {
  await run(client, db, { dropRole: role })
}
