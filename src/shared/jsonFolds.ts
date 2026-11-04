/**
 * Puts arrays holding a single plain value on one line (`tags: ['x']` instead of three lines). Arrays of one object,
 * or of more than one value, keep their layout.
 */
export function inlineSingleValueArrays(text: string): string {
  return text.replace(/\[\n[ \t]*([^\s{[\]][^\n]*?)\n[ \t]*\]/g, (all, value: string) => (/[{[,]$/.test(value) ? all : `[${value}]`))
}

/**
 * Fold ranges for the JSON view: every object or array that is the value of a document's top-level field, so each
 * document shows its fields with nested values as `{…}` / `[…]` (like Compass). `indent` is the text's indent unit;
 * documents start at column 0.
 */
export function nestedFieldFolds(text: string, indent = 2): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  const pad = ' '.repeat(indent)
  let open: number | null = null
  let pos = 0
  for (const line of text.split('\n')) {
    const field = line.startsWith(pad) && line[indent] !== ' '
    if (field) {
      const body = line.slice(indent)
      if (open === null && /[[{]$/.test(body)) open = pos + line.length
      else if (open !== null && /^[\]}]/.test(body)) {
        out.push({ from: open, to: pos + indent })
        open = null
      }
    }
    pos += line.length + 1
  }
  return out
}
