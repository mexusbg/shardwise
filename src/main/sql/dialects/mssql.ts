import type { BsonTypeName } from '@shared/bsonValue'
import { finite, isoMs } from './common'
import type { Dialect, SqlValue, TypeOptions, ValueKind } from './types'

const quote = (n: string): string => `[${n.replace(/]/g, ']]')}]`
const nstring = (s: string): string => `N'${s.replace(/'/g, "''")}'`

const TYPES: Partial<Record<BsonTypeName, string>> = {
  int: 'INT',
  long: 'BIGINT',
  double: 'FLOAT',
  decimal: 'DECIMAL(38,10)',
  bool: 'BIT',
  date: 'DATETIME2(3)',
  timestamp: 'DATETIME2(3)',
  objectId: 'VARCHAR(24)',
  uuid: 'UNIQUEIDENTIFIER',
  object: 'NVARCHAR(MAX)',
  array: 'NVARCHAR(MAX)'
}

export const mssql: Dialect = {
  id: 'mssql',
  // The server accepts 2100 parameters per request; keep a margin.
  maxParams: 2000,
  // Table value constructors are limited to 1000 rows.
  maxRows: 1000,
  maxIdent: 128,
  defaultSchema: 'dbo',
  quote,
  qualified: (s, t) => (s ? `${quote(s)}.${quote(t)}` : quote(t)),
  placeholder: (i) => `@p${i}`,
  typeFor(bson: BsonTypeName, o: TypeOptions = {}): string {
    if (bson === 'binary') return o.key ? 'VARBINARY(900)' : 'VARBINARY(MAX)'
    if (TYPES[bson]) return TYPES[bson]!
    return o.key ? 'NVARCHAR(450)' : 'NVARCHAR(MAX)'
  },
  types: ['NVARCHAR(MAX)', 'NVARCHAR(450)', 'VARCHAR(24)', 'VARCHAR(MAX)', 'INT', 'BIGINT', 'SMALLINT', 'FLOAT', 'REAL', 'DECIMAL(38,10)', 'BIT', 'DATETIME2(3)', 'DATETIMEOFFSET(3)', 'DATE', 'VARBINARY(MAX)', 'UNIQUEIDENTIFIER'],
  bind: (v: SqlValue) => (typeof v === 'bigint' ? v.toString() : v),
  literal(v: SqlValue, kind: ValueKind): string {
    if (v === null) return 'NULL'
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (typeof v === 'number') return finite(v)
    if (typeof v === 'bigint') return String(v)
    if (v instanceof Date) return `'${isoMs(v).replace('Z', '')}'`
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
    if (kind === 'decimal') return v
    return nstring(v)
  },
  dropTable: (q) => `DROP TABLE IF EXISTS ${q}`,
  createIfMissing: (q, _s, _t, create) => `IF OBJECT_ID(${nstring(q)}, N'U') IS NULL\n${create}`,
  emptyTables: (qs) => qs.map((q) => `DELETE FROM ${q}`),
  begin: 'BEGIN TRANSACTION',
  commit: 'COMMIT',
  limit: (sql, n) => `SELECT TOP (${n}) * FROM (${sql}) AS q`,
  scriptBom: true
}
