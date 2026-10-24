import { promises as fs } from 'fs'
import { Transform } from 'stream'
import { TextDecoder } from 'util'
import type { TextEncoding } from '@shared/api'

/*
 * Character encodings of imported text files. Files written by Excel ("CSV") or older tools on Windows use the
 * ANSI code page (windows-1251 on Bulgarian / Russian systems), Windows PowerShell writes UTF-16 LE: decode them
 * to text instead of assuming UTF-8.
 */

export type ResolvedEncoding = Exclude<TextEncoding, 'auto'>

export interface EncodingChoice {
  encoding: ResolvedEncoding
  /** Set when the encoding is a guess the user should check. */
  note?: string
}

/** Bytes read to detect the encoding. */
const SAMPLE_BYTES = 1 << 20

/** Encoding announced by a byte order mark. */
export function sniffBom(buf: Uint8Array): ResolvedEncoding | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
  return null
}

/** Valid UTF-8; a multi-byte sequence cut at the end of an incomplete sample is fine. */
export function isValidUtf8(buf: Uint8Array, complete = true): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: !complete })
    return true
  } catch {
    return false
  }
}

/** UTF-16 without a BOM: text of mostly ASCII has a zero byte in every other position. */
function utf16Guess(buf: Uint8Array): ResolvedEncoding | null {
  const n = Math.min(buf.length, 4096) & ~1
  if (n < 4) return null
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) even++
    if (buf[i + 1] === 0) odd++
  }
  const pairs = n / 2
  if (odd > pairs * 0.4 && even < pairs * 0.05) return 'utf-16le'
  if (even > pairs * 0.4 && odd < pairs * 0.05) return 'utf-16be'
  return null
}

/** Locales whose Windows ANSI code page is 1251 (Cyrillic). */
export function isCyrillicLocale(locale: string | undefined): boolean {
  if (!locale) return false
  const l = locale.toLowerCase().replace('_', '-')
  if (/^(sr|bs)-.*latn/.test(l)) return false
  return /^(bg|ru|uk|be|mk|sr|kk|ky|tg|mn|tt|ba|sah|cv|os|ce)(-|$)/.test(l)
}

/** The system locale (BCP 47-ish), for the code page guess. */
export function systemLocale(): string {
  const env = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG
  if (env && !/^(C|POSIX)(\.|$)/.test(env)) return env.split('.')[0]
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return ''
  }
}

/**
 * Single-byte text that is not UTF-8: Cyrillic (windows-1251) when the letters are mostly high bytes, as in
 * Bulgarian / Russian text; Western (windows-1252) when high bytes are sparse accents among ASCII letters.
 */
function legacyGuess(buf: Uint8Array, locale: string): ResolvedEncoding {
  if (isCyrillicLocale(locale)) return 'windows-1251'
  let high = 0
  let ascii = 0
  const n = Math.min(buf.length, SAMPLE_BYTES)
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c >= 0xc0) high++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) ascii++
  }
  return high > 0 && high / (high + ascii) > 0.3 ? 'windows-1251' : 'windows-1252'
}

/** Encoding of a text sample: BOM, then UTF-16 / UTF-8, then a legacy code page guess. */
export function detectEncoding(sample: Uint8Array, complete: boolean, locale = systemLocale()): EncodingChoice {
  const bom = sniffBom(sample)
  if (bom) return { encoding: bom }
  const u16 = utf16Guess(sample)
  if (u16) return { encoding: u16, note: `The file has no byte order mark; it was read as ${u16.toUpperCase()}.` }
  if (isValidUtf8(sample, complete)) return { encoding: 'utf-8' }
  const legacy = legacyGuess(sample, locale)
  return { encoding: legacy, note: `The file is not valid UTF-8; it was read as ${legacy}. Choose another encoding if the text looks wrong.` }
}

/** The encoding to read `path` with: the chosen one, or the detected one for `auto`. */
export async function resolveEncoding(path: string, choice: TextEncoding | undefined, locale?: string): Promise<EncodingChoice> {
  if (choice && choice !== 'auto') return { encoding: choice }
  const fh = await fs.open(path, 'r')
  try {
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.min(size, SAMPLE_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return detectEncoding(buf.subarray(0, bytesRead), bytesRead >= size, locale)
  } finally {
    await fh.close()
  }
}

/** A streaming decoder; a leading BOM of the encoding is dropped. */
export function textDecoder(encoding: ResolvedEncoding): TextDecoder {
  try {
    return new TextDecoder(encoding)
  } catch {
    throw new Error(`The ${encoding} encoding is not supported by this runtime`)
  }
}

/** Transform: bytes in `encoding` → UTF-8 bytes (BOM removed). */
export function toUtf8Stream(encoding: ResolvedEncoding): Transform {
  const dec = textDecoder(encoding)
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const s = dec.decode(chunk, { stream: true })
      cb(null, s ? Buffer.from(s, 'utf8') : undefined)
    },
    flush(cb) {
      const s = dec.decode()
      cb(null, s ? Buffer.from(s, 'utf8') : undefined)
    }
  })
}

/** Decode a whole buffer, detecting the encoding (for previews). `complete` = false when the buffer is a prefix. */
export function decodeText(buf: Uint8Array, complete = true, locale?: string): { text: string } & EncodingChoice {
  const choice = detectEncoding(buf, complete, locale)
  const text = textDecoder(choice.encoding).decode(buf, { stream: !complete })
  return { text, ...choice }
}
