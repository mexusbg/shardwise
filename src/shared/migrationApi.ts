import type { Doc } from './api'
import type { BsonTypeName } from './bsonValue'
import type { SshConfig } from './connection'

/**
 * SQL ⇄ MongoDB migration contract. Implemented by
 * `migrationHandlers()` in src/main/sql/migrations.ts.
 */

export type SqlDialect = 'postgres' | 'mysql' | 'mssql' | 'sqlite'

export const SQL_DIALECTS: { id: SqlDialect; label: string; port: number }[] = [
  { id: 'postgres', label: 'PostgreSQL', port: 5432 },
  { id: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { id: 'mssql', label: 'SQL Server', port: 1433 },
  { id: 'sqlite', label: 'SQLite', port: 0 }
]

export const dialectLabel = (d: SqlDialect): string => SQL_DIALECTS.find((x) => x.id === d)?.label ?? d

export interface SqlTlsConfig {
  enabled: boolean
  /** Verify the server certificate (SQL Server: false = trust server certificate). */
  rejectUnauthorized: boolean
  /** PEM CA file. */
  caFile?: string
}

export interface SqlConnectionConfig {
  id: string
  name: string
  dialect: SqlDialect
  host: string
  port: number
  /** Database (PostgreSQL / MySQL / SQL Server). */
  database: string
  user: string
  password: string
  /** SQLite database file. */
  file: string
  tls: SqlTlsConfig
  ssh: SshConfig
  /** SQL Server named instance. */
  instance?: string
}

export const newSqlConnection = (dialect: SqlDialect = 'postgres'): SqlConnectionConfig => ({
  id: '',
  name: '',
  dialect,
  host: 'localhost',
  port: SQL_DIALECTS.find((d) => d.id === dialect)!.port,
  database: '',
  user: '',
  password: '',
  file: '',
  tls: { enabled: false, rejectUnauthorized: true },
  ssh: { enabled: false, port: 22, method: 'password' }
})

export interface SqlTestResult {
  ok: boolean
  serverVersion?: string
  error?: string
  ms: number
}

// ---------------------------------------------------------------------------
// Schema browser
// ---------------------------------------------------------------------------

export interface SqlTableInfo {
  schema: string
  name: string
  kind: 'table' | 'view'
}

export interface SqlColumnInfo {
  name: string
  /** Declared type, e.g. `character varying(40)`. */
  type: string
  nullable: boolean
}

export interface SqlForeignKey {
  name: string
  /** Referencing table (the one holding the key). */
  schema: string
  table: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}

export interface SqlTableDetail {
  schema: string
  name: string
  columns: SqlColumnInfo[]
  primaryKey: string[]
  /** Keys of this table pointing to other tables. */
  foreignKeys: SqlForeignKey[]
  /** Keys of other tables pointing to this one. */
  referencedBy: SqlForeignKey[]
}

// ---------------------------------------------------------------------------
// MongoDB → SQL
// ---------------------------------------------------------------------------

/** Objects: flattened columns (`address_city`), a 1:1 child table or one JSON column. Arrays: child table or JSON. */
export type ToSqlMode = 'flatten' | 'table' | 'json'

export interface ToSqlField {
  /** Key in the document (array-of-documents children: key in the element). */
  name: string
  kind: 'scalar' | 'object' | 'array'
  /** Most common non-null type; for arrays the most common element type. */
  bson: BsonTypeName
  /** Values (or array elements) seen in the sample. */
  count: number
  /** Values of a non-null type other than `bson` (converted, or NULL when impossible). */
  mixed: number
  nulls: number
  /** Longest string in the sample. */
  maxLen?: number
  include: boolean
  /** Column name (scalars, JSON) or prefix of flattened columns (objects). */
  column: string
  /** SQL type override; '' = default for the dialect. */
  sqlType: string
  mode?: ToSqlMode
  /** Child table name (mode `table`). */
  table?: string
  /** Object fields, or fields of array-of-documents elements. */
  fields?: ToSqlField[]
  /** Set when the keys differ per document (a map keyed by ids…): distinct keys seen; stored as JSON. */
  distinctKeys?: number
  /** Root pseudo-field `*`: every top-level key not listed in the mapping, stored together as one JSON column. */
  rest?: boolean
}

export interface ToSqlCollection {
  coll: string
  include: boolean
  /** Root table name. */
  table: string
  /** Documents sampled to infer the mapping. */
  sampled: number
  /** Optional filter applied when reading the collection. */
  filter?: Doc
  /** Root fields; `_id` is the primary key. */
  fields: ToSqlField[]
}

export type ToSqlRunMode = 'create' | 'dropCreate' | 'append' | 'truncate'

export type ToSqlTarget =
  | { kind: 'connection'; sqlConnId: string; schema?: string }
  | { kind: 'file'; path: string; dialect: SqlDialect; schema?: string }

export interface ToSqlRequest {
  connId: string
  db: string
  collections: ToSqlCollection[]
  target: ToSqlTarget
  mode: ToSqlRunMode
  /** Documents per transaction. */
  batchSize: number
}

export interface PlannedColumn {
  name: string
  type: string
  nullable: boolean
  /** Part of the primary key. */
  key: boolean
  /** Field path (`address.city`), or `(parent)`, `(index)`, `(value)`. */
  source: string
}

export interface PlannedTable {
  id: string
  name: string
  coll: string
  parent?: string
  /** Field path the rows come from (root: ''). */
  path: string
  kind: 'root' | 'object' | 'documents' | 'scalars'
  columns: PlannedColumn[]
  primaryKey: string[]
  foreignKey?: { columns: string[]; table: string; refColumns: string[] }
}

export interface ToSqlPreviewTable {
  table: string
  columns: string[]
  /** Display text (NULL = null). */
  rows: (string | null)[][]
}

export interface ToSqlPreview {
  dialect: SqlDialect
  tables: PlannedTable[]
  ddl: string
  rows: ToSqlPreviewTable[]
  /** Field path → default SQL type for the dialect, per collection. */
  autoTypes: Record<string, Record<string, string>>
  warnings: string[]
}

// ---------------------------------------------------------------------------
// SQL → MongoDB
// ---------------------------------------------------------------------------

export type SqlConvert = 'auto' | 'string' | 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'date' | 'binary' | 'json' | 'objectId' | 'uuid'

export const SQL_CONVERTS: { id: SqlConvert; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'string', label: 'String' },
  { id: 'int', label: 'Int32' },
  { id: 'long', label: 'Int64' },
  { id: 'double', label: 'Double' },
  { id: 'decimal', label: 'Decimal128' },
  { id: 'bool', label: 'Boolean' },
  { id: 'date', label: 'Date' },
  { id: 'binary', label: 'Binary' },
  { id: 'json', label: 'JSON → document' },
  { id: 'objectId', label: 'ObjectId' },
  { id: 'uuid', label: 'UUID' }
]

export interface FromSqlColumn {
  column: string
  /** Declared SQL type when known. */
  type?: string
  /** Target field; dots create nested documents. */
  field: string
  include: boolean
  convert: SqlConvert
}

/**
 * Rows of `table` whose `foreignColumns` equal this row's `localColumns`: child rows (one-to-many, `array`)
 * or a referenced row (`object`).
 */
export interface FromSqlEmbed {
  id: string
  include: boolean
  schema: string
  table: string
  localColumns: string[]
  foreignColumns: string[]
  field: string
  as: 'array' | 'object'
  columns: FromSqlColumn[]
}

export interface FromSqlSource {
  id: string
  kind: 'table' | 'query'
  schema?: string
  table?: string
  query?: string
  include: boolean
  collection: string
  /** `pk`: `_id` from `idColumns` (one column → value, several → sub-document); `new`: new ObjectId. */
  idMode: 'pk' | 'new'
  idColumns: string[]
  columns: FromSqlColumn[]
  embeds: FromSqlEmbed[]
}

export interface FromSqlRequest {
  sqlConnId: string
  connId: string
  db: string
  sources: FromSqlSource[]
  /** `upsert` replaces documents with the same `_id`. */
  mode: 'insert' | 'upsert'
  dropTarget: boolean
  batchSize: number
}

export interface FromSqlPreview {
  docs: Doc[]
  columns: SqlColumnInfo[]
}

/** Renderer-callable methods; implemented by `migrationHandlers()` in src/main/sql/migrations.ts. */
export interface MigrationApi {
  sqlListConnections(): SqlConnectionConfig[]
  sqlSaveConnection(c: SqlConnectionConfig): SqlConnectionConfig
  sqlDeleteConnection(id: string): void
  sqlTestConnection(c: SqlConnectionConfig): SqlTestResult
  sqlListSchemas(sqlConnId: string): string[]
  sqlListTables(sqlConnId: string, schema: string): SqlTableInfo[]
  sqlDescribeTable(sqlConnId: string, schema: string, table: string): SqlTableDetail
  /** Common column types of a dialect, for the type pickers. */
  sqlDialectTypes(dialect: SqlDialect): string[]
  sqlDefaultSchema(sqlConnId: string): string

  migrationInferToSql(connId: string, db: string, colls: string[], sample: number): ToSqlCollection[]
  migrationPreviewToSql(req: ToSqlRequest): ToSqlPreview
  migrationStartToSql(req: ToSqlRequest): string

  /** Default mapping for a table or a custom SELECT. */
  migrationDefaultSource(sqlConnId: string, from: { schema: string; table: string } | { query: string }): FromSqlSource
  migrationPreviewFromSql(sqlConnId: string, source: FromSqlSource): FromSqlPreview
  migrationStartFromSql(req: FromSqlRequest): string

  migrationCancel(jobId: string): void
}
