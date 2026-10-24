import type { BsonTypeName } from '@shared/bsonValue'
import { finite, isoMs, quoteString } from './common'
import type { Dialect, SqlValue, ValueKind } from './types'

const quote = (n: string): string => `"${n.replace(/"/g, '""')}"`
const noNul = (s: string): string => (s.includes('\0') ? s.replace(/\0/g, '') : s)

const TYPES: Partial<Record<BsonTypeName, string>> = {
  string: 'TEXT',
  int: 'INTEGER',
  long: 'BIGINT',
  double: 'DOUBLE PRECISION',
  decimal: 'NUMERIC(38,10)',
  bool: 'BOOLEAN',
  date: 'TIMESTAMP(3) WITH TIME ZONE',
  timestamp: 'TIMESTAMP(3) WITH TIME ZONE',
  objectId: 'CHAR(24)',
  binary: 'BYTEA',
  uuid: 'UUID',
  object: 'JSONB',
  array: 'JSONB'
}

export const postgres: Dialect = {
  id: 'postgres',
  maxParams: 65535,
  maxRows: 1000,
  maxIdent: 63,
  defaultSchema: 'public',
  quote,
  qualified: (s, t) => (s ? `${quote(s)}.${quote(t)}` : quote(t)),
  placeholder: (i) => `$${i}`,
  typeFor: (bson) => TYPES[bson] ?? 'TEXT',
  types: ['TEXT', 'VARCHAR(255)', 'CHAR(24)', 'INTEGER', 'BIGINT', 'SMALLINT', 'DOUBLE PRECISION', 'REAL', 'NUMERIC(38,10)', 'BOOLEAN', 'TIMESTAMP(3) WITH TIME ZONE', 'TIMESTAMP(3)', 'DATE', 'BYTEA', 'UUID', 'JSONB', 'JSON'],
  bind: (v: SqlValue) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? noNul(v) : v),
  literal(v: SqlValue, kind: ValueKind): string {
    if (v === null) return 'NULL'
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    if (typeof v === 'number') return finite(v)
    if (typeof v === 'bigint') return String(v)
    if (v instanceof Date) return quoteString(isoMs(v))
    if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`
    if (kind === 'decimal') return v
    return quoteString(noNul(v))
  },
  dropTable: (q) => `DROP TABLE IF EXISTS ${q} CASCADE`,
  createIfMissing: (_q, _s, _t, create) => create.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '),
  emptyTables: (qs) => (qs.length ? [`TRUNCATE TABLE ${qs.join(', ')}`] : []),
  begin: 'BEGIN',
  commit: 'COMMIT',
  limit: (sql, n) => `SELECT * FROM (${sql}) AS q LIMIT ${n}`,
  // psql on Windows defaults client_encoding to the console code page (WIN866 / WIN1251).
  scriptPrologue: ["SET client_encoding = 'UTF8'"]
}
