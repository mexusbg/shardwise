import { createReadStream } from 'fs'
import { pipeline } from 'stream'
import { parse } from 'csv-parse'
import { stringify } from 'csv-stringify/sync'
import { getPath } from '@shared/docPaths'
import type { CsvColumnType, Doc, FilePreview, TextEncoding } from '@shared/api'
import { convertText, csvCell, normDelimiter, rowToDoc } from './tabular'
import { fileSize, TextFile } from './io'
import type { DocSink, DocSource, ImportItem } from './io'
import { resolveEncoding, toUtf8Stream } from './encoding'
import type { EncodingChoice } from './encoding'

export interface CsvExportOptions {
  fields: string[]
  delimiter: string
  header: boolean
  /** Write a UTF-8 BOM first (Excel on Windows otherwise reads the file in the ANSI code page). */
  bom?: boolean
}

/** One CSV line (with trailing newline) for the given cells. */
export function csvLine(cells: string[], delimiter: string): string {
  return stringify([cells], { delimiter: normDelimiter(delimiter), record_delimiter: '\n' })
}

export function docToCsvCells(doc: Doc, fields: string[]): string[] {
  return fields.map((f) => csvCell(getPath(doc, f)))
}

export function createCsvSink(path: string, o: CsvExportOptions): DocSink {
  const file = new TextFile(path)
  const delimiter = normDelimiter(o.delimiter)
  let started = false
  const start = async (): Promise<void> => {
    if (started) return
    started = true
    if (o.bom) await file.write('\uFEFF')
    if (o.header) await file.write(csvLine(o.fields, delimiter))
  }
  return {
    async write(doc) {
      await start()
      await file.write(csvLine(docToCsvCells(doc, o.fields), delimiter))
    },
    async close() {
      await start()
      await file.close()
    },
    destroy: () => file.destroy()
  }
}

/**
 * Stream documents from a CSV file whose first row holds the field names (dot paths nest). The text is decoded
 * with `encoding` (`auto`: BOM, else UTF-8 when valid, else a legacy code page such as windows-1251).
 */
export function readCsvDocs(
  path: string,
  delimiter: string,
  columnTypes: Record<string, CsvColumnType> = {},
  signal?: AbortSignal,
  encoding: TextEncoding = 'auto'
): DocSource & { headers: () => string[]; encoding: () => EncodingChoice | undefined } {
  let size = 0
  let read = 0
  let headers: string[] = []
  let chosen: EncodingChoice | undefined
  return {
    progress: () => (size ? Math.min(1, read / size) : 0),
    headers: () => headers,
    encoding: () => chosen,
    async *[Symbol.asyncIterator](): AsyncGenerator<ImportItem> {
      size = await fileSize(path)
      chosen = await resolveEncoding(path, encoding)
      const stream = createReadStream(path, { highWaterMark: 1 << 20 })
      const parser = parse({
        delimiter: normDelimiter(delimiter),
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true
      })
      // The decoder drops a UTF-8 / UTF-16 BOM; `bom: true` stays as a safety net.
      pipeline(stream, toUtf8Stream(chosen.encoding), parser, () => {})
      let row = 0
      try {
        for await (const record of parser as AsyncIterable<string[]>) {
          signal?.throwIfAborted()
          read = stream.bytesRead
          row++
          if (row === 1) {
            headers = record.map((h) => h.trim())
            continue
          }
          try {
            yield { doc: rowToDoc(headers, record, (cell, h) => convertText(cell ?? '', columnTypes[h] ?? 'auto')) }
          } catch (e) {
            yield { error: `Row ${row}: ${(e as Error).message}` }
          }
        }
        read = size
      } finally {
        stream.destroy()
        parser.destroy()
      }
    }
  }
}

export async function previewCsv(path: string, delimiter: string, max = 20, encoding: TextEncoding = 'auto'): Promise<FilePreview> {
  const src = readCsvDocs(path, delimiter, {}, undefined, encoding)
  const sample: Doc[] = []
  for await (const item of src) {
    if (item.doc) sample.push(item.doc)
    if (sample.length >= max) break
  }
  const enc = src.encoding()
  return { columns: src.headers(), sample, encoding: enc?.encoding, ...(enc?.note ? { encodingNote: enc.note } : {}) }
}
