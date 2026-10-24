import type { Doc } from './api'

/**
 * Data masking (copy / export / mask in place with per-field rules) and Restructure Fields (ordered field operations
 * compiled to an update pipeline) contract.
 */

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

export type MaskKind =
  | 'keep'
  | 'remove'
  | 'redact'
  | 'partial'
  | 'hash'
  | 'fake'
  | 'number'
  | 'noise'
  | 'dateShift'
  | 'nullify'
  | 'constant'

export type FakeKind = 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'street' | 'city' | 'company' | 'lorem' | 'uuid'

export interface MaskRule {
  /** Dot path; array levels are traversed (`items.sku` masks every element's sku). */
  path: string
  kind: MaskKind
  /** redact: replacement text (default `***`). */
  text?: string
  /** partial: `chars` keeps the first/last N characters, `email` keeps the first N of the local part and the domain. */
  partial?: 'chars' | 'email'
  keepStart?: number
  keepEnd?: number
  /** partial: mask character (default `*`). */
  maskChar?: string
  /** partial: leave separators (spaces, dashes, dots…) unmasked. */
  keepSeparators?: boolean
  /** hash: overrides the profile salt. */
  salt?: string
  fake?: FakeKind
  /** fake / number / noise / dateShift: same input → same output (seeded from the value's hash). */
  consistent?: boolean
  /** number: range and decimals (0 = integer). */
  min?: number
  max?: number
  decimals?: number
  /** noise: ± percent. */
  percent?: number
  /** dateShift: ± days. */
  days?: number
  /** constant: the value written. */
  value?: unknown
}

export interface MaskSource {
  connId: string
  db: string
  coll: string
  /** {} = whole collection. */
  filter: Doc
}

export type MaskTarget =
  | { kind: 'collection'; connId: string; db: string; coll: string; dropFirst: boolean }
  /** `confirm` must equal the source collection name. */
  | { kind: 'inPlace'; confirm: string }
  /** Relaxed EJSON, one document per line. */
  | { kind: 'file'; path: string }

export interface MaskRequest {
  source: MaskSource
  rules: MaskRule[]
  /** Secret mixed into hashes and consistent fakes; keep it to reproduce the same output. */
  salt: string
  target: MaskTarget
}

/** Saved masking profile (JSON file, canonical EJSON so constant values keep their BSON types). */
export interface MaskProfile {
  format: 'shardwise-mask-profile'
  version: 1
  salt: string
  rules: MaskRule[]
}

export interface PreviewPair {
  before: Doc
  after: Doc
}

// ---------------------------------------------------------------------------
// Restructure Fields
// ---------------------------------------------------------------------------

export type ConvertTarget = 'string' | 'int' | 'long' | 'double' | 'decimal' | 'date' | 'objectId' | 'bool' | 'array' | 'first'

export type ReschemaOp =
  /** Rename or move (into / out of sub-documents). */
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'remove'; path: string }
  /** Set a value where the field is missing (and, with `orNull`, where it is null). */
  | { kind: 'default'; path: string; value: unknown; orNull?: boolean }
  /**
   * Change the type. `format` (date only) accepts `DD/MM/YYYY`-style tokens or `%d/%m/%Y`; `onError` decides
   * what failing values become.
   */
  | { kind: 'convert'; path: string; to: ConvertTarget; format?: string; onError: 'keep' | 'null' }
  /** String → array by separator; `to` defaults to `path`. */
  | { kind: 'split'; path: string; separator: string; trim?: boolean; dropEmpty?: boolean; to?: string }
  /** Concatenate fields (missing / null skipped). */
  | { kind: 'merge'; paths: string[]; separator: string; to: string; removeSources?: boolean }
  /** `address: { city }` → `address_city` (next to the sub-document, which is removed). */
  | { kind: 'flatten'; path: string; prefix: string }
  /** `address_city` → `address: { city }`; `parent` = '' for top-level fields. */
  | { kind: 'nest'; prefix: string; to: string; parent?: string }
  /** Array element (negative index from the end) into `to` (default: replace the array). */
  | { kind: 'extract'; path: string; index: number; to?: string; removeSource?: boolean }

export interface ReschemaRequest {
  connId: string
  db: string
  coll: string
  filter: Doc
  ops: ReschemaOp[]
}

export interface ConversionFailure {
  /** Index into `ops`. */
  op: number
  path: string
  to: ConvertTarget
  count: number
  /** First failing `_id`s. */
  sampleIds: unknown[]
}

export interface ReschemaDryRun {
  matched: number
  /** Documents whose content would differ after the update. */
  changed: number
  failures: ConversionFailure[]
  ms: number
}

export interface ReschemaApplyOptions {
  /** 0 = one `updateMany`; otherwise batches of this many `_id`s with progress and cancel. */
  batchSize: number
}

/** Renderer-callable methods; implemented by `maskingHandlers()` in src/main/masking/masking.ts. */
export interface MaskingApi {
  maskingPreview(source: MaskSource, rules: MaskRule[], salt: string, limit: number): PreviewPair[]
  maskingStart(req: MaskRequest): string
  maskingCancel(jobId: string): void
  reschemaPreview(req: ReschemaRequest, limit: number): PreviewPair[]
  reschemaDryRun(req: ReschemaRequest): ReschemaDryRun
  reschemaStart(req: ReschemaRequest, opts: ReschemaApplyOptions): string
}
