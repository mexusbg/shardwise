import type { SqlDialect } from '@shared/migrationApi'
import { mssql } from './mssql'
import { mysql } from './mysql'
import { postgres } from './postgres'
import { sqlite } from './sqlite'
import type { Dialect } from './types'

export const DIALECTS: Record<SqlDialect, Dialect> = { postgres, mysql, mssql, sqlite }

export function getDialect(id: SqlDialect): Dialect {
  const d = DIALECTS[id]
  if (!d) throw new Error(`Unknown SQL dialect ${id}`)
  return d
}

export type { Dialect, SqlValue, ValueKind } from './types'
