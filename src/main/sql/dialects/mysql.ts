import type { BsonTypeName } from '@shared/bsonValue'
import { finite, quoteString, sqlDateTime } from './common'
import type { Dialect, SqlValue, TypeOptions, ValueKind } from './types'

const quote = (n: string): string => `\`${n.replace(/`/g, '``')}\``

const TYPES: Partial<Record<BsonTypeName, string>> = {
  int: 'INT',
  long: 'BIGINT',
  double: 'DOUBLE',
  decimal: 'DECIMAL(38,10)',
  bool: 'TINYINT(1)',
  date: 'DATETIME(3)',
  timestamp: 'DATETIME(3)',
  objectId: 'CHAR(24)',
  uuid: 'CHAR(36)',
  object: 'JSON',
  array: 'JSON'
}

export const mysql: Dialect = {
  id: 'mysql',
  maxParams: 65535,
  maxRows: 1000,
  maxIdent: 64,
  defaultSchema: '',
  quote,
  qualified: (s, t) => (s ? `${quote(s)}.${quote(t)}` : quote(t)),
  placeholder: () => '?',
  typeFor(bson: BsonTypeName, o: TypeOptions = {}): string {
    if (bson === 'binary') return o.key ? 'VARBINARY(255)' : 'LONGBLOB'
    if (TYPES[bson]) return TYPES[bson]!
    if (o.key) return 'VARCHAR(255)'
    return (o.maxLen ?? 0) > 16000 ? 'LONGTEXT' : 'TEXT'
  },
  types: ['TEXT', 'LONGTEXT', 'VARCHAR(255)', 'CHAR(24)', 'CHAR(36)', 'INT', 'BIGINT', 'SMALLINT', 'DOUBLE', 'FLOAT', 'DECIMAL(38,10)', 'TINYINT(1)', 'DATETIME(3)', 'TIMESTAMP(3)', 'DATE', 'LONGBLOB', 'VARBINARY(255)', 'JSON'],
  bind: (v: SqlValue) => (typeof v === 'bigint' ? v.toString() : v),
  literal(v: SqlValue, kind: ValueKind): string {
    if (v === null) return 'NULL'
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (typeof v === 'number') return finite(v)
    if (typeof v === 'bigint') return String(v)
    if (v instanceof Date) return quoteString(sqlDateTime(v))
    if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
    if (kind === 'decimal') return v
    return quoteString(v, true)
  },
  dropTable: (q) => `DROP TABLE IF EXISTS ${q}`,
  createIfMissing: (_q, _s, _t, create) => create.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '),
  emptyTables: (qs) => qs.map((q) => `DELETE FROM ${q}`),
  begin: 'START TRANSACTION',
  commit: 'COMMIT',
  limit: (sql, n) => `SELECT * FROM (${sql}) AS q LIMIT ${n}`,
  // MySQL 5.7 / MariaDB default to latin1: Cyrillic and other non-Latin text would become '?'.
  tableOptions: 'DEFAULT CHARSET=utf8mb4',
  keyCollation: 'utf8mb4_bin',
  scriptPrologue: ['SET NAMES utf8mb4']
}
