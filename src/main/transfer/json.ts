import { createReadStream } from 'fs'
import { collectPaths } from '@shared/docPaths'
import type { Doc, FilePreview, JsonFlavor, TextEncoding } from '@shared/api'
import { resolveEncoding, textDecoder } from './encoding'
import type { EncodingChoice } from './encoding'
import { DocSplitter, JsonLayout, parseDocText } from './jsonFormat'
import type { DocSyntax } from './jsonFormat'
import { fileSize, TextFile } from './io'
import type { DocSink, DocSource, ImportItem } from './io'

export interface JsonExportOptions {
  flavor: JsonFlavor
  layout: 'lines' | 'array'
  pretty: boolean
}

export function createJsonSink(path: string, o: JsonExportOptions): DocSink {
  const file = new TextFile(path)
  const layout = new JsonLayout(o.flavor, o.layout, o.pretty)
  let started = false
  const start = async (): Promise<void> => {
    if (started) return
    started = true
    await file.write(layout.start())
  }
  return {
    async write(doc) {
      await start()
      await file.write(layout.doc(doc))
    },
    async close() {
      await start()
      await file.write(layout.end())
      await file.close()
    },
    destroy: () => file.destroy()
  }
}

/**
 * Stream documents from a JSON file of any supported flavour and layout. Structural errors (unbalanced
 * braces) throw; a document that fails to parse is yielded as an error item so the import can go on.
 */
export function readJsonDocs(path: string, signal?: AbortSignal, encoding: TextEncoding = 'auto'): DocSource & { encoding: () => EncodingChoice | undefined } {
  let size = 0
  let read = 0
  let chosen: EncodingChoice | undefined
  return {
    progress: () => (size ? Math.min(1, read / size) : 0),
    encoding: () => chosen,
    async *[Symbol.asyncIterator](): AsyncGenerator<ImportItem> {
      size = await fileSize(path)
      chosen = await resolveEncoding(path, encoding)
      const decoder = textDecoder(chosen.encoding)
      const stream = createReadStream(path, { highWaterMark: 1 << 20 })
      const splitter = new DocSplitter()
      let syntax: DocSyntax = 'ejson'
      try {
        const chunks = async function* (): AsyncGenerator<string> {
          for await (const buf of stream as AsyncIterable<Buffer>) yield decoder.decode(buf, { stream: true })
          yield decoder.decode()
        }
        for await (const chunk of chunks()) {
          signal?.throwIfAborted()
          read = stream.bytesRead
          for (const part of splitter.push(chunk)) {
            try {
              const r = parseDocText(part.text, syntax)
              syntax = r.syntax
              yield { doc: r.doc }
            } catch (e) {
              yield { error: `Line ${part.line}: ${(e as Error).message}` }
            }
          }
        }
        splitter.end()
        read = size
      } finally {
        stream.destroy()
      }
    }
  }
}

export async function previewJson(path: string, max = 20, encoding: TextEncoding = 'auto'): Promise<FilePreview> {
  const sample: Doc[] = []
  const errors: string[] = []
  const src = readJsonDocs(path, undefined, encoding)
  try {
    for await (const item of src) {
      if (item.doc) sample.push(item.doc)
      else if (item.error) errors.push(item.error)
      if (sample.length >= max || errors.length >= max) break
    }
  } catch (e) {
    if (!sample.length) throw e
  }
  if (!sample.length && errors.length) throw new Error(errors[0])
  const enc = src.encoding()
  return { columns: collectPaths(sample), sample, encoding: enc?.encoding, ...(enc?.note ? { encodingNote: enc.note } : {}) }
}
