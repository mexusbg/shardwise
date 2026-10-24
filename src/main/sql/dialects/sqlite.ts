import type { BsonTypeName } from '@shared/bsonValue'
import { finite, isoMs, quoteString } from './common'
import type { Dialect, SqlValue, ValueKind } from './types'

const quote = (n: string): string => `"${n.replace(/"/g, '""')}"`

const TYPES: Partial<Record<BsonTypeName, string>> = {
  string: 'TEXT',
  int: 'INTEGER',
  long: 'BIGINT',
  double: 'REAL',
  decimal: 'NUMERIC',
  bool: 'BOOLEAN',
  date: 'DATETIME',
  timestamp: 'DATETIME',
  objectId: 'CHAR(24)',
  binary: 'BLOB',
  uuid: 'UUID',
  object: 'JSON',
  array: 'JSON'
}

export const sqlite: Dialect = {
  id: 'sqlite',
  maxParams: 32766,
  maxRows: 500,
  maxIdent: 1000,
  defaultSchema: '',
  quote,
  qualified: (s, t) => (s ? `${quote(s)}.${quote(t)}` : quote(t)),
  placeholder: () => '?',
  typeFor: (bson) => TYPES[bson] ?? 'TEXT',
  types: ['TEXT', 'CHAR(24)', 'INTEGER', 'BIGINT', 'REAL', 'NUMERIC', 'BOOLEAN', 'DATETIME', 'BLOB', 'UUID', 'JSON'],
  bind(v: SqlValue): unknown {
    if (typeof v === 'boolean') return v ? 1 : 0
    if (v instanceof Date) return isoMs(v)
    return v
  },
  literal(v: SqlValue, kind: ValueKind): string {
    if (v === null) return 'NULL'
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (typeof v === 'number') return finite(v)
    if (typeof v === 'bigint') return String(v)
    if (v instanceof Date) return quoteString(isoMs(v))
    if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
    if (kind === 'decimal') return v
    return quoteString(v)
  },
  dropTable: (q) => `DROP TABLE IF EXISTS ${q}`,
  createIfMissing: (_q, _s, _t, create) => create.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '),
  emptyTables: (qs) => qs.map((q) => `DELETE FROM ${q}`),
  begin: 'BEGIN',
  commit: 'COMMIT',
  limit: (sql, n) => `SELECT * FROM (${sql}) LIMIT ${n}`
}
