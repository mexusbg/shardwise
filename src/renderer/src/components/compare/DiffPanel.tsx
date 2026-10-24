import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { bsonTypeOf, isPlainDoc, shellText } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import type { CompareCategory, CompareEntry, FieldDiff } from '@shared/compareApi'
import { errorText } from '../../state/store'
import { Icon } from '../Icon'
import { compareApi } from './compareClient'

type Mark = FieldDiff['kind'] | 'inner'

interface Line {
  depth: number
  path: string
  label?: string
  open?: string
  close?: string
  value?: unknown
  leaf?: boolean
  comma: boolean
}

function buildLines(doc: Doc): Line[] {
  const out: Line[] = []
  const walk = (v: unknown, label: string | undefined, path: string, depth: number, comma: boolean): void => {
    const arr = Array.isArray(v)
    const entries: [string, unknown][] = arr ? (v as unknown[]).map((x, i) => [String(i), x]) : isPlainDoc(v) ? Object.entries(v) : []
    if ((arr || isPlainDoc(v)) && entries.length) {
      out.push({ depth, path, label, open: arr ? '[' : '{', comma: false })
      entries.forEach(([k, x], i) => walk(x, arr ? undefined : k, path ? `${path}.${k}` : k, depth + 1, i < entries.length - 1))
      out.push({ depth, path, close: arr ? ']' : '}', comma })
    } else out.push({ depth, path, label, value: v, leaf: true, comma })
  }
  walk(doc, undefined, '', 0, false)
  return out
}

function marker(diffs: FieldDiff[]): (path: string) => Mark | undefined {
  const exact = new Map(diffs.map((d) => [d.path, d.kind]))
  const inner = new Set<string>()
  for (const d of diffs) {
    const segs = d.path.split('.')
    for (let i = 1; i < segs.length; i++) inner.add(segs.slice(0, i).join('.'))
  }
  return (path) => {
    if (!path) return undefined
    const m = exact.get(path)
    if (m) return m
    const segs = path.split('.')
    for (let i = segs.length - 1; i > 0; i--) {
      const up = exact.get(segs.slice(0, i).join('.'))
      if (up) return up
    }
    return inner.has(path) ? 'inner' : undefined
  }
}

const KIND_LABEL: Record<FieldDiff['kind'], string> = { added: 'only in target', removed: 'only in source', changed: 'changed' }

function ValueSpan({ v }: { v: unknown }): ReactElement {
  return <span className={`t-${bsonTypeOf(v)}`}>{shellText(v)}</span>
}

export function DocPane({ doc, diffs, side, title }: { doc: Doc | null; diffs: FieldDiff[]; side: 'source' | 'target'; title: string }): ReactElement {
  const lines = useMemo(() => (doc ? buildLines(doc) : []), [doc])
  const markOf = useMemo(() => marker(diffs), [diffs])
  return (
    <div className={`cmp-pane cmp-pane-${side}`}>
      <div className="cmp-pane-head">
        <span className={`cmp-side-dot ${side}`} />
        <span className="ellipsis" title={title}>
          {title}
        </span>
      </div>
      <div className="cmp-code selectable">
        {!doc && <div className="cmp-pane-missing">Document not found on this side</div>}
        {lines.map((l, i) => {
          const m = markOf(l.path)
          return (
            <div key={i} className={`cmp-line ${m ? `mk-${m}` : ''}`} title={m && m !== 'inner' ? `${l.path}: ${KIND_LABEL[m]}` : undefined}>
              <span className="cmp-gutter">{m === 'changed' ? '~' : m === 'added' ? '+' : m === 'removed' ? '−' : m === 'inner' ? '·' : ''}</span>
              <span style={{ paddingLeft: l.depth * 16 }}>
                {l.label !== undefined && (
                  <>
                    <span className="cmp-key">{l.label}</span>
                    <span className="faint">: </span>
                  </>
                )}
                {l.open}
                {l.close}
                {l.leaf && <ValueSpan v={l.value} />}
                {l.comma && <span className="faint">,</span>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const short = (v: unknown): string => {
  const s = shellText(v)
  return s.length > 300 ? `${s.slice(0, 297)}…` : s
}

function ChangeList({ entry }: { entry: CompareEntry }): ReactElement {
  const diffs = entry.diffs ?? []
  return (
    <div className="cmp-changes selectable">
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Source</th>
            <th />
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((d) => (
            <tr key={d.path} className={`ck-${d.kind}`}>
              <td className="mono cmp-ch-path">
                <span className={`cmp-kind ${d.kind}`}>{d.kind === 'changed' ? '~' : d.kind === 'added' ? '+' : '−'}</span>
                {d.path}
              </td>
              <td className="mono">{d.kind === 'added' ? <span className="faint">missing</span> : <span className={`t-${bsonTypeOf(d.source)}`}>{short(d.source)}</span>}</td>
              <td className="cmp-arrow">→</td>
              <td className="mono">{d.kind === 'removed' ? <span className="faint">missing</span> : <span className={`t-${bsonTypeOf(d.target)}`}>{short(d.target)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entry.more ? <div className="faint cmp-more">… and {entry.more.toLocaleString()} more differences</div> : null}
    </div>
  )
}

interface Props {
  jobId: string
  entry: CompareEntry
  category: CompareCategory
  sourceTitle: string
  targetTitle: string
}

/** Detail of one compared key: side-by-side documents with highlighted paths, or the list of changes. */
export function DiffPanel({ jobId, entry, category, sourceTitle, targetTitle }: Props): ReactElement {
  const [mode, setMode] = useState<'side' | 'list'>('side')
  const [docs, setDocs] = useState<{ source: Doc | null; target: Doc | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const diffs = entry.diffs ?? []

  useEffect(() => {
    let alive = true
    setDocs(null)
    setError(null)
    compareApi
      .compareDocs(jobId, entry.key)
      .then((d) => alive && setDocs(d))
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [jobId, entry])

  const showSource = category !== 'onlyTarget'
  const showTarget = category !== 'onlySource'
  const counts = { changed: 0, added: 0, removed: 0 }
  for (const d of diffs) counts[d.kind]++

  return (
    <div className="cmp-detail">
      <div className="cmp-detail-head">
        <span className="faint">Key</span>
        <span className="mono ellipsis selectable cmp-detail-key" title={shellText(entry.key)}>
          {shellText(entry.key)}
        </span>
        {category === 'different' && (
          <span className="cmp-detail-stats">
            {counts.changed > 0 && <span className="cmp-kind changed">~ {counts.changed} changed</span>}
            {counts.removed > 0 && <span className="cmp-kind removed">− {counts.removed} only in source</span>}
            {counts.added > 0 && <span className="cmp-kind added">+ {counts.added} only in target</span>}
          </span>
        )}
        <span className="spacer" />
        {category === 'different' && (
          <div className="segmented small">
            <button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>
              <Icon name="compare" size={12} /> Side by side
            </button>
            <button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>
              <Icon name="table" size={12} /> Changes
            </button>
          </div>
        )}
      </div>
      {error && <div className="notice error cmp-detail-error">{error}</div>}
      {category === 'different' && mode === 'list' ? (
        <ChangeList entry={entry} />
      ) : !docs && !error ? (
        <div className="cmp-placeholder">
          <span className="cmp-spinner" /> Loading documents…
        </div>
      ) : docs ? (
        <div className={`cmp-panes ${showSource && showTarget ? 'two' : 'one'}`}>
          {showSource && <DocPane doc={docs.source} diffs={diffs} side="source" title={sourceTitle} />}
          {showTarget && <DocPane doc={docs.target} diffs={diffs} side="target" title={targetTitle} />}
        </div>
      ) : null}
    </div>
  )
}
