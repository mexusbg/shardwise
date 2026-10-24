import type { Doc } from './api'

/** GridFS browser: buckets are `<name>.files` + `<name>.chunks` collection pairs. */

export interface GridFsBucketInfo {
  name: string
  /** Estimated number of files (-1 = unknown). */
  files: number
}

export interface GridFsFile {
  _id: unknown
  filename: string
  length: number
  chunkSize: number
  uploadDate: Date
  /** Top-level `contentType` (legacy drivers) or `metadata.contentType`. */
  contentType?: string
  metadata?: Doc
}

export type GridFsSortField = 'filename' | 'length' | 'uploadDate' | 'contentType'

export interface GridFsListRequest {
  /** Case-insensitive filename substring. */
  search: string
  sort: { field: GridFsSortField; dir: 1 | -1 }
  skip: number
  limit: number
}

export interface GridFsListResult {
  files: GridFsFile[]
  total: number
}

export interface GridFsPreview {
  kind: 'image' | 'text' | 'binary' | 'empty'
  mime: string
  /** Base64 for images, UTF-8 text for text. */
  data?: string
  /** Only the first PREVIEW_LIMIT bytes were read. */
  truncated: boolean
  length: number
}

export const GRIDFS_PREVIEW_LIMIT = 2 * 1024 * 1024

export interface GridFsUploadOptions {
  /** Stored in the file document's `metadata` (merged with `contentType`). */
  metadata?: Doc
  /** Auto-detected from the extension when empty. */
  contentType?: string
  /** Name for a single uploaded file; defaults to the file's base name. */
  filename?: string
  chunkSizeBytes?: number
}

/** Renderer-callable methods; implemented by `gridFsHandlers()` in src/main/gridfs/gridfs.ts. */
export interface GridFsApi {
  gridfsBuckets(connId: string, db: string): GridFsBucketInfo[]
  gridfsList(connId: string, db: string, bucket: string, req: GridFsListRequest): GridFsListResult
  gridfsFile(connId: string, db: string, bucket: string, id: unknown): GridFsFile | null
  /** Streams files to disk as a job; one file to `target.file`, or any number into `target.folder`. */
  gridfsDownload(connId: string, db: string, bucket: string, ids: unknown[], target: { file: string } | { folder: string }): string
  gridfsUpload(connId: string, db: string, bucket: string, paths: string[], opts: GridFsUploadOptions): string
  gridfsDelete(connId: string, db: string, bucket: string, ids: unknown[]): number
  gridfsRename(connId: string, db: string, bucket: string, id: unknown, filename: string): void
  /** Replaces the file document's `metadata`. */
  gridfsSetMetadata(connId: string, db: string, bucket: string, id: unknown, metadata: Doc | null): void
  gridfsPreview(connId: string, db: string, bucket: string, id: unknown): GridFsPreview
  gridfsCancel(jobId: string): void
}
