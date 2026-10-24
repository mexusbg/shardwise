import { createReadStream, promises as fs } from 'fs'
import type { ReadStream } from 'fs'
import { createInflateRaw, inflateRawSync } from 'zlib'

/*
 * Minimal streaming .xlsx reader: random access to the zip parts through the central directory, the
 * worksheet XML inflated and scanned row by row. (exceljs' streaming reader relies on `unzipper`, which
 * randomly drops zip entries on current Node versions.)
 */

export type XlsxCell = string | number | boolean | Date | null

interface ZipEntry {
  method: number
  compSize: number
  localOffset: number
}

/** Central directory of a zip file (no zip64). */
async function zipDirectory(path: string): Promise<Map<string, ZipEntry>> {
  const fh = await fs.open(path, 'r')
  try {
    const size = (await fh.stat()).size
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found)')
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 .xlsx files are not supported')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const out = new Map<string, ZipEntry>()
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      out.set(cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'), {
        method: cd.readUInt16LE(p + 10),
        compSize: cd.readUInt32LE(p + 20),
        localOffset: cd.readUInt32LE(p + 42)
      })
      p += 46 + nameLen + extraLen + commentLen
    }
    return out
  } finally {
    await fh.close()
  }
}

async function dataStart(path: string, e: ZipEntry): Promise<number> {
  const fh = await fs.open(path, 'r')
  try {
    const lh = Buffer.alloc(30)
    await fh.read(lh, 0, 30, e.localOffset)
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt .xlsx file (bad local header)')
    return e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  } finally {
    await fh.close()
  }
}

async function readEntry(path: string, e: ZipEntry): Promise<Buffer> {
  const start = await dataStart(path, e)
  const fh = await fs.open(path, 'r')
  try {
    const data = Buffer.alloc(e.compSize)
    await fh.read(data, 0, e.compSize, start)
    if (e.method === 0) return data
    if (e.method === 8) return inflateRawSync(data)
    throw new Error(`Unsupported zip compression method ${e.method}`)
  } finally {
    await fh.close()
  }
}

// ---------------------------------------------------------------------------
// XML helpers (the parts are machine-written, well-formed XML)
// ---------------------------------------------------------------------------

const P = '(?:[\\w.-]+:)?' // optional namespace prefix

export function xmlDecode(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    switch (e) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'amp':
        return '&'
    }
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  })
}

const attrRes = new Map<string, RegExp>()

function attr(tag: string, name: string): string | undefined {
  let re = attrRes.get(name)
  if (!re) attrRes.set(name, (re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)))
  const m = re.exec(tag)
  return m ? xmlDecode(m[1] ?? m[2]) : undefined
}

/** Concatenated text of all <t> elements (rich text runs), ignoring phonetic hints. */
function textOf(xml: string): string {
  const clean = xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g'), '')
  let out = ''
  const re = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)</${P}t>|<${P}t(?:\\s[^>]*)?/>`, 'g')
  for (let m = re.exec(clean); m; m = re.exec(clean)) out += m[1] ?? ''
  return xmlDecode(out)
}

// ---------------------------------------------------------------------------
// Workbook metadata
// ---------------------------------------------------------------------------

/** Built-in number formats that display dates / times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** Does a custom number format code display a date or time? */
export function isDateFormat(code: string): boolean {
  const s = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?:h+|m+|s+)\]/gi, 'h')
    .replace(/\[[^\]]*\]/g, '')
    .split(';')[0]
  return /[dmyhs]/i.test(s) && !/^[#0.,%\s]*$/.test(s) && !/general/i.test(s)
}

export interface XlsxSheet {
  name: string
  /** Zip path of the worksheet part. */
  part?: string
}

export interface XlsxWorkbook {
  path: string
  sheets: XlsxSheet[]
  /** Read the rows of a sheet, streaming. */
  rows(sheet: XlsxSheet, signal?: AbortSignal): AsyncGenerator<{ number: number; cells: XlsxCell[] }>
  /** Bytes of the current sheet part consumed so far / total (for progress). */
  progress(): number
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = `xl/${target}`.split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join('/')
}

/** Excel serial date → JS Date (UTC). */
export function excelDate(serial: number, date1904: boolean): Date {
  const days = date1904 ? serial + 1462 : serial
  return new Date(Math.round((days - 25569) * 86400000))
}

/** Column index (0-based) of a cell reference like "AB12". */
export function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64)
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96)
    else break
  }
  return n - 1
}

export async function openXlsx(path: string): Promise<XlsxWorkbook> {
  const dir = await zipDirectory(path)
  const text = async (name: string): Promise<string | undefined> => {
    const e = dir.get(name)
    return e ? (await readEntry(path, e)).toString('utf8') : undefined
  }
  const wbXml = await text('xl/workbook.xml')
  if (!wbXml) throw new Error('Not an Excel workbook (xl/workbook.xml is missing)')
  const relsXml = (await text('xl/_rels/workbook.xml.rels')) ?? ''
  const rels = new Map<string, { target: string; type: string }>()
  for (const tag of relsXml.match(new RegExp(`<${P}Relationship\\b[^>]*>`, 'g')) ?? []) {
    const id = attr(tag, 'Id')
    const target = attr(tag, 'Target')
    if (id && target) rels.set(id, { target: resolveTarget(target), type: attr(tag, 'Type') ?? '' })
  }
  const sheets: XlsxSheet[] = (wbXml.match(new RegExp(`<${P}sheet\\b[^>]*>`, 'g')) ?? []).map((tag) => {
    const rid = attr(tag, '[\\w]+:id')
    return { name: attr(tag, 'name') ?? '', part: rid ? rels.get(rid)?.target : undefined }
  })
  const pr = new RegExp(`<${P}workbookPr\\b[^>]*>`).exec(wbXml)?.[0] ?? ''
  const date1904 = /^(1|true)$/i.test(attr(pr, 'date1904') ?? '')

  const findPart = (type: string, fallback: string): string => {
    for (const r of rels.values()) if (r.type.endsWith(`/${type}`)) return r.target
    return fallback
  }

  // Shared strings
  const shared: string[] = []
  const ssXml = await text(findPart('sharedStrings', 'xl/sharedStrings.xml'))
  if (ssXml) {
    const re = new RegExp(`<${P}si\\b[^>]*>([\\s\\S]*?)</${P}si>|<${P}si\\b[^>]*/>`, 'g')
    for (let m = re.exec(ssXml); m; m = re.exec(ssXml)) shared.push(m[1] ? textOf(m[1]) : '')
  }

  // Styles: which cell formats are dates
  const dateStyles = new Set<number>()
  const stXml = await text(findPart('styles', 'xl/styles.xml'))
  if (stXml) {
    const custom = new Map<number, string>()
    for (const tag of stXml.match(new RegExp(`<${P}numFmt\\b[^>]*>`, 'g')) ?? []) {
      custom.set(Number(attr(tag, 'numFmtId')), attr(tag, 'formatCode') ?? '')
    }
    const xfs = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`).exec(stXml)?.[1] ?? ''
    const tags = xfs.match(new RegExp(`<${P}xf\\b[^>]*>`, 'g')) ?? []
    tags.forEach((tag, i) => {
      const id = Number(attr(tag, 'numFmtId') ?? 0)
      const code = custom.get(id)
      if (code !== undefined ? isDateFormat(code) : DATE_FORMAT_IDS.has(id)) dateStyles.add(i)
    })
  }

  let input: ReadStream | null = null
  let total = 0

  const cellValue = (tag: string, inner: string): XlsxCell => {
    const t = attr(tag, 't') ?? 'n'
    if (t === 'inlineStr') {
      const is = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)</${P}is>`).exec(inner)
      return is ? textOf(is[1]) : ''
    }
    const vm = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)</${P}v>`).exec(inner)
    if (!vm) return null
    const v = vm[1]
    switch (t) {
      case 's':
        return shared[Number(v)] ?? ''
      case 'str':
        return xmlDecode(v)
      case 'b':
        return v.trim() === '1' || v.trim().toLowerCase() === 'true'
      case 'e':
        return null
      case 'd': {
        const d = new Date(xmlDecode(v))
        return Number.isNaN(d.getTime()) ? xmlDecode(v) : d
      }
    }
    const n = Number(v)
    if (Number.isNaN(n)) return xmlDecode(v)
    const s = attr(tag, 's')
    return s !== undefined && dateStyles.has(Number(s)) ? excelDate(n, date1904) : n
  }

  const parseRow = (rowTag: string, inner: string, fallback: number): { number: number; cells: XlsxCell[] } => {
    const cells: XlsxCell[] = []
    const re = new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g')
    let next = 0
    for (let m = re.exec(inner); m; m = re.exec(inner)) {
      const tag = ` ${m[1]}`
      const r = attr(tag, 'r')
      const col = r ? columnIndex(r) : next
      next = col + 1
      cells[col] = m[2] === undefined ? null : cellValue(tag, m[2])
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null
    const num = Number(attr(` ${rowTag}`, 'r'))
    return { number: Number.isFinite(num) && num > 0 ? num : fallback, cells }
  }

  async function* rows(sheet: XlsxSheet, signal?: AbortSignal): AsyncGenerator<{ number: number; cells: XlsxCell[] }> {
    const entry = sheet.part ? dir.get(sheet.part) : undefined
    if (!entry) throw new Error(`Sheet '${sheet.name}' has no data part`)
    const start = await dataStart(path, entry)
    total = entry.compSize
    input = createReadStream(path, { start, end: start + Math.max(entry.compSize, 1) - 1, highWaterMark: 1 << 20 })
    const stream = entry.method === 8 ? input.pipe(createInflateRaw()) : input
    stream.setEncoding('utf8')
    const rowRe = new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, 'g')
    let buf = ''
    let count = 0
    try {
      for await (const chunk of stream as AsyncIterable<string>) {
        signal?.throwIfAborted()
        buf += chunk
        rowRe.lastIndex = 0
        let consumed = 0
        for (let m = rowRe.exec(buf); m; m = rowRe.exec(buf)) {
          consumed = rowRe.lastIndex
          count++
          yield parseRow(m[1], m[2] ?? '', count)
        }
        if (consumed) buf = buf.slice(consumed)
        else if (buf.length > 64 * 1024 * 1024) throw new Error('Worksheet row too large')
      }
    } finally {
      input.destroy()
      if (stream !== input) (stream as NodeJS.ReadableStream & { destroy(): void }).destroy()
    }
  }

  return {
    path,
    sheets,
    rows,
    progress: () => (total && input ? Math.min(1, input.bytesRead / total) : 0)
  }
}
