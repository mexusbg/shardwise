import { createWriteStream, promises as fs } from 'fs'
import { finished } from 'stream/promises'
import ExcelJS from 'exceljs'
import { getPath } from '@shared/docPaths'
import type { CsvColumnType, Doc, FilePreview } from '@shared/api'
import { convertCell, plainCell, rowToDoc, sheetName, xlsxCell } from './tabular'
import type { DocSink, DocSource, ImportItem } from './io'
import { openXlsx } from './xlsxRead'
import type { XlsxCell } from './xlsxRead'

export function createXlsxSink(path: string, fields: string[], sheet: string): DocSink {
  const out = createWriteStream(path)
  let outError: Error | null = null
  out.on('error', (e) => (outError = e))
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false })
  const ws = wb.addWorksheet(sheetName(sheet), { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = fields.map((f) => ({ key: f, width: Math.min(60, Math.max(10, f.length + 2)) }))
  const header = ws.addRow(fields)
  header.font = { bold: true }
  header.commit()
  let rows = 0
  return {
    async write(doc) {
      if (outError) throw outError
      ws.addRow(fields.map((f) => xlsxCell(getPath(doc, f)))).commit()
      // Let the zip stream drain now and then; exceljs does not apply back-pressure itself.
      if (++rows % 1000 === 0) await new Promise((r) => setImmediate(r))
    },
    async close() {
      ws.commit()
      await wb.commit()
      await finished(out).catch(() => {})
      if (outError) throw outError
    },
    async destroy() {
      out.destroy()
      await fs.rm(path, { force: true }).catch(() => {})
    }
  }
}


/**
 * Stream documents from an Excel sheet (first sheet unless `sheet` names one). The first row holds the
 * field names; cell types (numbers, dates, booleans) are kept.
 */
export function readXlsxDocs(
  path: string,
  sheet: string | undefined,
  columnTypes: Record<string, CsvColumnType> = {},
  signal?: AbortSignal
): DocSource & { headers: () => string[]; sheets: () => string[] } {
  let headers: string[] = []
  let sheets: string[] = []
  let progress = (): number => 0
  return {
    progress: () => progress(),
    headers: () => headers,
    sheets: () => sheets,
    async *[Symbol.asyncIterator](): AsyncGenerator<ImportItem> {
      const wb = await openXlsx(path)
      progress = () => wb.progress()
      sheets = wb.sheets.map((s) => s.name)
      const wanted = sheet ? wb.sheets.find((s) => s.name === sheet) : wb.sheets[0]
      if (!wanted) throw new Error(sheet ? `Sheet '${sheet}' not found` : 'The workbook has no sheets')
      let first = true
      for await (const row of wb.rows(wanted, signal)) {
        const cells = row.cells.map((c) => plainCell(c) as XlsxCell)
        if (first) {
          headers = cells.map((c) => (c === null ? '' : c instanceof Date ? c.toISOString() : String(c)).trim())
          first = false
          continue
        }
        if (!cells.some((c) => c !== null && c !== '')) continue
        try {
          yield { doc: rowToDoc(headers, cells, (c, h) => convertCell(c ?? null, columnTypes[h] ?? 'auto')) }
        } catch (e) {
          yield { error: `Row ${row.number}: ${(e as Error).message}` }
        }
      }
      progress = () => 1
    }
  }
}

export async function previewXlsx(path: string, sheet?: string, max = 20): Promise<FilePreview> {
  const src = readXlsxDocs(path, sheet)
  const sample: Doc[] = []
  const it = src[Symbol.asyncIterator]()
  try {
    while (sample.length < max) {
      const r = await it.next()
      if (r.done) break
      if (r.value.doc) sample.push(r.value.doc)
    }
  } finally {
    await it.return?.(undefined)
  }
  return { columns: src.headers(), sample, sheets: src.sheets() }
}
