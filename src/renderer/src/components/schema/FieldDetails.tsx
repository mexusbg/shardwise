import type { ReactElement, ReactNode } from 'react'
import { bsonTypeOf, cellText } from '@shared/bsonValue'
import type { FieldQuery, FieldReport, TypeStats } from '@shared/schema'
import { Icon } from '../Icon'
import { TypeBar } from './FieldTree'
import { fmtDate, fmtInt, fmtNum, fmtPct, typeColor } from './schemaUi'

function ValueText({ v }: { v: unknown }): ReactElement {
  const t = bsonTypeOf(v)
  if (t === 'string' && v === '') return <span className="faint">(empty string)</span>
  const text = cellText(v)
  return (
    <span className={`mono t-${t}`} title={text}>
      {t === 'string' ? `"${text}"` : text}
    </span>
  )
}

function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }): ReactElement {
  return (
    <section className="sx-section">
      <div className="sx-section-head">
        <span>{title}</span>
        {extra}
      </div>
      {children}
    </section>
  )
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }): ReactElement {
  return (
    <div className="sx-tile">
      <div className="sx-tile-label">{label}</div>
      <div className="sx-tile-value">{value}</div>
      {sub && <div className="sx-tile-sub">{sub}</div>}
    </div>
  )
}

function BarRow(p: { label: ReactNode; pct: number; count: number; color: string; onQuery?: () => void; queryTitle?: string }): ReactElement {
  return (
    <div className={`sx-bar-row${p.onQuery ? ' clickable' : ''}`} onClick={p.onQuery} title={p.queryTitle}>
      <span className="sx-bar-label ellipsis">{p.label}</span>
      <span className="sx-bar-track">
        <span className="sx-bar-fill" style={{ width: `${Math.max(p.pct * 100, 0.8)}%`, background: p.color }} />
      </span>
      <span className="sx-bar-num">{fmtInt(p.count)}</span>
      <span className="sx-bar-pct">{fmtPct(p.pct)}</span>
      {p.onQuery && (
        <span className="sx-bar-go">
          <Icon name="filter" size={12} />
        </span>
      )}
    </div>
  )
}

function statPairs(t: TypeStats): [string, ReactNode][] {
  if (t.number) return [['Min', fmtNum(t.number.min)], ['Max', fmtNum(t.number.max)], ['Average', fmtNum(t.number.avg)]]
  if (t.string)
    return [['Min length', fmtInt(t.string.min)], ['Max length', fmtInt(t.string.max)], ['Avg length', fmtNum(Math.round(t.string.avg * 10) / 10)]]
  if (t.date) return [['Earliest', fmtDate(t.date.min)], ['Latest', fmtDate(t.date.max)]]
  if (t.objectId) return [['Created from', fmtDate(t.objectId.min)], ['Created to', fmtDate(t.objectId.max)]]
  if (t.array) {
    const pairs: [string, ReactNode][] = [
      ['Min length', fmtInt(t.array.min)],
      ['Max length', fmtInt(t.array.max)],
      ['Avg length', fmtNum(Math.round(t.array.avg * 10) / 10)]
    ]
    if (t.array.elementTypes.length)
      pairs.push([
        'Elements',
        <span key="el" className="sx-el-types">
          {t.array.elementTypes.map((e) => (
            <span key={e.type} className={`t-${e.type}`}>
              {e.label} <span className="faint">{fmtPct(e.pct)}</span>
            </span>
          ))}
        </span>
      ])
    return pairs
  }
  return []
}

interface Props {
  field: FieldReport
  sampled: number
  /** Missing for merged map keys (`perms.*`): they have no path to query. */
  onQuery?: (q: FieldQuery) => void
}

export function FieldDetails({ field: f, sampled, onQuery }: Props): ReactElement {
  const kinds = f.types.filter((t) => t.type !== 'null' && t.type !== 'undefined').map((t) => t.label)
  const statTypes = f.types.filter((t) => statPairs(t).length)
  const unique = !f.distinctCapped && f.distinct === f.count && f.count > 1
  const what = f.isElement ? 'contains an element of type' : 'is of type'
  return (
    <div className="sx-details selectable">
      <div className="sx-dhead">
        <div className="sx-dpath mono">{f.path}</div>
        <div className="sx-badges">
          {f.isElement ? (
            <span className="badge">Array elements</span>
          ) : f.always ? (
            <span className="badge sx-ok">Always present</span>
          ) : (
            <span className="badge">Optional</span>
          )}
          {f.nullable && <span className="badge">Nullable</span>}
          {unique && <span className="badge">Unique in sample</span>}
          {f.queryPath !== f.path && (
            <span className="faint">
              query as <span className="mono">{f.queryPath}</span>
            </span>
          )}
        </div>
      </div>

      {f.mapKeys !== undefined && (
        <div className="sx-note faint">
          {fmtInt(f.mapKeys)} different keys in the sample look like data (ids, dates…), not field names: they are merged into{' '}
          <span className="mono">{f.path}.*</span>.
        </div>
      )}
      {f.dynamic && <div className="sx-note faint">Merged from the keys of a map-like object: it has no single path, so it cannot be queried from here.</div>}
      {f.mixed && (
        <div className="notice sx-notice">
          <Icon name="warn" size={14} />
          <span>
            <b>Mixed types:</b> {kinds.join(', ')}. Queries, sorts and indexes treat each BSON type separately, so values of one type are
            easily missed — consider normalising this field.
          </span>
        </div>
      )}
      {f.numericMix && (
        <div className="sx-note faint">
          Numbers are stored as {kinds.join(' and ')}. Usually harmless: numeric comparisons work across numeric types.
        </div>
      )}

      <div className="sx-tiles">
        <Stat label="Presence" value={fmtPct(f.presence)} sub={`${fmtInt(f.docCount)} of ${fmtInt(sampled)} documents`} />
        <Stat
          label={f.isElement ? 'Elements' : 'Values'}
          value={fmtInt(f.count)}
          sub={f.isElement ? 'across all arrays' : f.parentCount !== sampled ? `in ${fmtInt(f.parentCount)} parent objects` : undefined}
        />
        <Stat
          label="Distinct"
          value={f.distinct ? `${f.distinctCapped ? '≥ ' : ''}${fmtInt(f.distinct)}` : '—'}
          sub={f.distinct ? (f.distinctCapped ? 'capped estimate' : 'in sample') : 'not tracked for documents / arrays'}
        />
        <Stat label="Types" value={f.types.length} sub={<TypeBar types={f.types} className="sx-tbar wide" />} />
      </div>

      <div className="sx-actions" hidden={!onQuery}>
        <button className="btn small" onClick={() => onQuery?.({ kind: 'exists' })}>
          <Icon name="filter" size={13} /> Find where it exists
        </button>
        {!f.isElement && f.presence < 1 && (
          <button className="btn small" onClick={() => onQuery?.({ kind: 'missing' })}>
            <Icon name="filter" size={13} /> Find where it is missing
          </button>
        )}
        {f.topValues[0] && (
          <button className="btn small" onClick={() => onQuery?.({ kind: 'equals', value: f.topValues[0].value })}>
            <Icon name="filter" size={13} /> Find where it equals top value
          </button>
        )}
      </div>

      <Section title="Type distribution">
        {f.types.map((t) => (
          <BarRow
            key={t.type}
            label={<span className={`t-${t.type}`}>{t.label}</span>}
            pct={t.pct}
            count={t.count}
            color={typeColor(t.type)}
            onQuery={onQuery && (() => onQuery({ kind: 'type', type: t.type }))}
            queryTitle={`Find documents where ${f.queryPath} ${what} ${t.label}`}
          />
        ))}
      </Section>

      {statTypes.length > 0 && (
        <Section title="Statistics">
          <div className="sx-stat-cards">
            {statTypes.map((t) => (
              <div key={t.type} className="sx-stat-card">
                <div className={`sx-stat-type t-${t.type}`}>{t.label}</div>
                <dl>
                  {statPairs(t).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd className="mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Section>
      )}

      {f.topValues.length > 0 ? (
        <Section title="Top values" extra={onQuery && <span className="faint">click a value to query it</span>}>
          {f.topValues.map((v, i) => (
            <BarRow
              key={i}
              label={<ValueText v={v.value} />}
              pct={v.pct}
              count={v.count}
              color={typeColor(v.type)}
              onQuery={onQuery && (() => onQuery({ kind: 'equals', value: v.value }))}
              queryTitle={`Find documents where ${f.queryPath} equals this value`}
            />
          ))}
        </Section>
      ) : (
        f.distinct > 0 && (
          <Section title="Top values">
            <div className="sx-note faint">
              High cardinality: {f.distinctCapped ? 'at least ' : ''}
              {fmtInt(f.distinct)} distinct values in the sample, so top values are not listed.
            </div>
          </Section>
        )
      )}

      {f.samples.length > 0 && (
        <Section title="Sample values">
          <div className="sx-samples">
            {f.samples.map((v, i) => (
              <span key={i} className="sx-sample">
                <ValueText v={v} />
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
