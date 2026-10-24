import type { BsonTypeName } from '@shared/bsonValue'
import type { SqlDialect } from '@shared/migrationApi'

/** What a SQL column holds, derived from its type; decides how BSON values are converted for it. */
export type ValueKind = 'string' | 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'date' | 'objectId' | 'binary' | 'uuid' | 'json'

/**
 * Normalised SQL value: int/double → number, long → bigint, decimal → string, bool → boolean, date → Date,
 * objectId / uuid / json / string → string, binary → Buffer.
 */
export type SqlValue = null | string | number | bigint | boolean | Date | Buffer

export interface TypeOptions {
  /** Part of a primary / foreign key (needs an indexable type). */
  key?: boolean
  maxLen?: number
}

export interface Dialect {
  id: SqlDialect
  /** Bound parameters per statement. */
  maxParams: number
  /** Rows per multi-row INSERT. */
  maxRows: number
  /** Identifier length limit. */
  maxIdent: number
  defaultSchema: string
  quote(name: string): string
  /** `schema.table`, or just the table when the schema is empty. */
  qualified(schema: string, table: string): string
  /** 1-based parameter placeholder. */
  placeholder(i: number): string
  typeFor(bson: BsonTypeName, o?: TypeOptions): string
  /** Common types, for pickers. */
  types: string[]
  /** Value as a driver parameter. */
  bind(v: SqlValue, kind: ValueKind): unknown
  /** Value as a SQL literal (for .sql files). */
  literal(v: SqlValue, kind: ValueKind): string
  dropTable(qualified: string): string
  /** CREATE TABLE when missing. */
  createIfMissing(qualified: string, schema: string, table: string, create: string): string
  /** Delete all rows (child tables first). */
  emptyTables(qualified: string[]): string[]
  begin: string
  commit: string
  limit(sql: string, n: number): string
  /** Appended to CREATE TABLE (e.g. MySQL's character set, whose server default may be latin1). */
  tableOptions?: string
  /** Collation for text key columns: MongoDB compares `_id` strings binary, a case-insensitive key would collide. */
  keyCollation?: string
  /** Statements that start a generated .sql script (client character set). */
  scriptPrologue?: string[]
  /** Write generated .sql scripts with a UTF-8 BOM (SSMS / sqlcmd read files without one in the ANSI code page). */
  scriptBom?: boolean
}
