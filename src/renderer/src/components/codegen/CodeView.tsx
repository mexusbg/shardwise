import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { CODE_LANGUAGE_LABELS, CODE_LANGUAGES, generateCode } from '@shared/codegen'
import type { CodeLanguage, CodeQuery } from '@shared/codegen'
import { mongoToSql } from '@shared/mongoToSql'
import { api } from '../../lib/api'
import { parseCollationPart, parseQueryParts } from '../../lib/queryText'
import { formatCollation } from '@shared/collation'
import type { Collation } from '@shared/collation'
import { toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'

const KEY = 'shardwise.codeLanguage'

type Lang = CodeLanguage | 'sql'
const LANGS: Lang[] = [...CODE_LANGUAGES, 'sql']
const LABELS: Record<Lang, string> = { ...CODE_LANGUAGE_LABELS, sql: 'SQL' }

function savedLanguage(): Lang {
  try {
    const v = localStorage.getItem(KEY) as Lang | null
    return v && LANGS.includes(v) ? v : 'node'
  } catch {
    return 'node'
  }
}

function render(q: CodeQuery, lang: Lang): string {
  if (lang !== 'sql') return generateCode(q, lang)
  const shape = q.kind === 'find' ? { coll: q.coll, filter: q.filter, projection: q.projection, sort: q.sort, skip: q.skip, limit: q.limit } : { coll: q.coll, pipeline: q.pipeline }
  const r = mongoToSql(shape)
  if (r.sql === null) throw new Error(`This query has no SQL equivalent: ${r.reason}`)
  // SQL collations are named per database engine; say which one the query uses instead of guessing.
  if (q.collation && Object.keys(q.collation).length) return `-- MongoDB collation ${formatCollation(q.collation as unknown as Collation)} is not translated; add a COLLATE clause for your database if needed.\n${r.sql}`
  return r.sql
}

/** Generated driver code for a query; `build` returns the query or throws a readable error. */
export function CodeView({ build, deps }: { build: () => CodeQuery; deps: unknown[] }): ReactElement {
  const [lang, setLang] = useState<Lang>(savedLanguage)
  const result = useMemo(() => {
    try {
      return { code: render(build(), lang) }
    } catch (e) {
      return { error: (e as Error).message }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, ...deps])

  const choose = (l: Lang): void => {
    setLang(l)
    try {
      localStorage.setItem(KEY, l)
    } catch {
      // Only a convenience.
    }
  }

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="result-toolbar">
        <span className="muted">Language</span>
        <select className="select small" value={lang} onChange={(e) => choose(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {LABELS[l]}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          className="btn small"
          disabled={!result.code}
          onClick={async () => {
            await api.copyText(result.code!)
            toast('Code copied', 'success')
          }}
        >
          <Icon name="copy" size={12} /> Copy
        </button>
      </div>
      {result.error ? (
        <div className="notice error selectable" style={{ margin: 10 }}>
          {result.error}
        </div>
      ) : (
        <CodeEditor value={result.code!} readOnly full className="cm-json-view" />
      )}
    </div>
  )
}

/** Code view for a find query typed in a query tab. */
export function findCodeQuery(db: string, coll: string, texts: { query: string; projection: string; sort: string; skip: string; limit: string; collation?: string }): CodeQuery {
  const p = parseQueryParts(texts.query, texts.projection, texts.sort)
  const collation = parseCollationPart(texts.collation ?? '')
  return { kind: 'find', db, coll, filter: p.filter, projection: p.projection, sort: p.sort, skip: Number(texts.skip) || 0, limit: Number(texts.limit) || 0, collation }
}
