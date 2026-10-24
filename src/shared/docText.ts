import { EJSON } from 'bson'
import type { JsonStyle } from './api'
import { shellText } from './bsonValue'

/**
 * Text of a document (or list of documents) in the chosen style: mongosh syntax such as
 * `ObjectId('…')`, or Extended JSON v2 in relaxed (`{"$oid": …}`, plain numbers) or canonical form.
 */
export function docText(v: unknown, style: JsonStyle = 'shell', indent = 2): string {
  if (style === 'shell' || v === undefined) return shellText(v, indent)
  try {
    return EJSON.stringify(v as object, undefined, indent, { relaxed: style === 'relaxed' })
  } catch {
    // Values EJSON cannot represent (e.g. functions from a playground result) fall back to shell syntax.
    return shellText(v, indent)
  }
}

export const JSON_STYLE_LABELS: Record<JsonStyle, string> = {
  shell: 'Shell syntax',
  relaxed: 'Relaxed EJSON',
  canonical: 'Canonical EJSON'
}
