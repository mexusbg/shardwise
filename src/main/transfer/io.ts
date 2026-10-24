import { createWriteStream, promises as fs } from 'fs'
import type { WriteStream } from 'fs'
import { once } from 'events'
import { finished } from 'stream/promises'
import type { Doc } from '@shared/api'

/** Writes documents to an export file. */
export interface DocSink {
  write(doc: Doc): Promise<void>
  /** Finish the file. */
  close(): Promise<void>
  /** Abort: close and delete the partial file. */
  destroy(): Promise<void>
}

/** One item read from an import file: a document, or a per-record error (bad line / row). */
export interface ImportItem {
  doc?: Doc
  error?: string
}

/** Streaming reader of an import file. */
export interface DocSource extends AsyncIterable<ImportItem> {
  /** Fraction of the file consumed so far (0..1), for progress. */
  progress(): number
}

/** Text file writer honouring back-pressure. */
export class TextFile {
  private ws: WriteStream
  private error: Error | null = null

  constructor(private path: string) {
    this.ws = createWriteStream(path, { encoding: 'utf8' })
    this.ws.on('error', (e) => (this.error = e))
  }

  async write(s: string): Promise<void> {
    if (this.error) throw this.error
    if (!s) return
    if (!this.ws.write(s)) await once(this.ws, 'drain')
  }

  async close(): Promise<void> {
    if (this.error) throw this.error
    this.ws.end()
    await finished(this.ws)
  }

  async destroy(): Promise<void> {
    this.ws.destroy()
    await finished(this.ws).catch(() => {})
    await fs.rm(this.path, { force: true }).catch(() => {})
  }
}

/** Read up to `n` items from an async iterator, returning them and the iterator for the rest. */
export async function peek<T>(it: AsyncIterator<T>, n: number): Promise<{ head: T[]; done: boolean }> {
  const head: T[] = []
  while (head.length < n) {
    const r = await it.next()
    if (r.done) return { head, done: true }
    head.push(r.value)
  }
  return { head, done: false }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}
