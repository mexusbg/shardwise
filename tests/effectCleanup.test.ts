import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []
  })

describe('React effects', () => {
  // `useEffect(() => el.scrollIntoView())` returns the call's result as the cleanup: Chromium's scroll methods
  // return a Promise, React then throws "destroy is not a function" on unmount and the whole window goes blank.
  it('use a block body (or return a cleanup function) instead of returning an expression', () => {
    const bad: string[] = []
    for (const f of files('src/renderer/src')) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/use(Layout|Insertion)?Effect\(\s*\(\)\s*=>\s*(?!\{|\(\)\s*=>)\S/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(bad).toEqual([])
  })
})
