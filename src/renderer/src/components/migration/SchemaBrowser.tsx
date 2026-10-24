import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { SqlTableDetail, SqlTableInfo } from '@shared/migrationApi'
import { errorText } from '../../state/store'
import { Icon } from '../Icon'
import { migrationApi } from './migrationClient'

type Load<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; value: T }

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const [v, setV] = useState<Load<T>>({ state: 'loading' })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setV({ state: 'loading' })
    fn()
      .then((value) => alive && setV({ state: 'ok', value }))
      .catch((e) => alive && setV({ state: 'error', error: errorText(e) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return [v, () => setN((x) => x + 1)]
}

function Columns({ sqlConnId, t }: { sqlConnId: string; t: SqlTableInfo }): ReactElement {
  const [d] = useLoad<SqlTableDetail>(() => migrationApi.sqlDescribeTable(sqlConnId, t.schema, t.name), [sqlConnId, t.schema, t.name])
  if (d.state === 'loading') return <div className="mig-tree-row depth-3 faint">Loading…</div>
  if (d.state === 'error') return <div className="mig-tree-row depth-3 error-text ellipsis" title={d.error}>{d.error}</div>
  const fk = new Map<string, string>()
  for (const f of d.value.foreignKeys) f.columns.forEach((c, i) => fk.set(c, `→ ${f.refTable}.${f.refColumns[i] ?? ''}`))
  return (
    <>
      {d.value.columns.map((c) => {
        const pk = d.value.primaryKey.includes(c.name)
        return (
          <div key={c.name} className="mig-tree-row depth-3" title={`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${pk ? ' · primary key' : ''}${fk.has(c.name) ? ` · ${fk.get(c.name)}` : ''}`}>
            <span className={`mig-col-ico ${pk ? 'pk' : fk.has(c.name) ? 'fk' : ''}`}>
              <Icon name={pk ? 'key' : fk.has(c.name) ? 'link' : 'leaf'} size={11} />
            </span>
            <span className="ellipsis">{c.name}</span>
            <span className="faint mono mig-tree-type ellipsis">{c.type}</span>
          </div>
        )
      })}
      {d.value.referencedBy.length > 0 && (
        <div className="mig-tree-row depth-3 faint ellipsis" title={d.value.referencedBy.map((f) => `${f.table} (${f.columns.join(', ')})`).join('\n')}>
          <Icon name="link" size={11} /> referenced by {d.value.referencedBy.map((f) => f.table).join(', ')}
        </div>
      )}
    </>
  )
}

function Tables({ sqlConnId, schema, onAdd, added }: { sqlConnId: string; schema: string; onAdd?: (schema: string, table: string) => void; added?: Set<string> }): ReactElement {
  const [tables] = useLoad(() => migrationApi.sqlListTables(sqlConnId, schema), [sqlConnId, schema])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (tables.state === 'loading') return <div className="mig-tree-row depth-2 faint">Loading…</div>
  if (tables.state === 'error') return <div className="mig-tree-row depth-2 error-text ellipsis" title={tables.error}>{tables.error}</div>
  if (!tables.value.length) return <div className="mig-tree-row depth-2 faint">No tables</div>
  return (
    <>
      {tables.value.map((t) => {
        const isOpen = !!open[t.name]
        const isAdded = added?.has(`${t.schema}.${t.name}`)
        return (
          <div key={t.name}>
            <div className="mig-tree-row depth-2 clickable" onClick={() => setOpen((o) => ({ ...o, [t.name]: !isOpen }))} onDoubleClick={() => onAdd?.(t.schema, t.name)}>
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} className="mig-twisty" />
              <Icon name={t.kind === 'view' ? 'view' : 'table'} size={13} className="mig-tree-ico" />
              <span className="ellipsis grow">{t.name}</span>
              {onAdd && (
                <button
                  className={`btn ghost icon small mig-add ${isAdded ? 'on' : ''}`}
                  title={isAdded ? 'Added to the import' : 'Add to the import'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onAdd(t.schema, t.name)
                  }}
                >
                  <Icon name={isAdded ? 'check' : 'plus'} size={12} />
                </button>
              )}
            </div>
            {isOpen && <Columns sqlConnId={sqlConnId} t={t} />}
          </div>
        )
      })}
    </>
  )
}

/** Schemas → tables → columns of a saved SQL connection. */
export function SchemaBrowser({ sqlConnId, version, onAdd, added }: { sqlConnId: string; version: number; onAdd?: (schema: string, table: string) => void; added?: Set<string> }): ReactElement {
  const [data, reload] = useLoad(async () => {
    const [schemas, def] = await Promise.all([migrationApi.sqlListSchemas(sqlConnId), migrationApi.sqlDefaultSchema(sqlConnId)])
    return { schemas, def: def || schemas[0] || '' }
  }, [sqlConnId, version])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [gen, setGen] = useState(0)

  useEffect(() => {
    if (data.state === 'ok') setOpen((o) => (Object.keys(o).length ? o : { [data.value.def]: true }))
  }, [data])

  return (
    <div className="mig-tree">
      <div className="mig-tree-head">
        <span className="mig-label">Schema</span>
        <span className="spacer" />
        <button
          className="btn ghost icon small"
          title="Refresh"
          onClick={() => {
            reload()
            setGen((g) => g + 1)
          }}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div className="mig-tree-body">
        {data.state === 'loading' && (
          <div className="mig-tree-row faint">
            <span className="mig-spinner" /> Connecting…
          </div>
        )}
        {data.state === 'error' && <div className="mig-tree-error error-text selectable">{data.error}</div>}
        {data.state === 'ok' &&
          data.value.schemas.map((s) => (
            <div key={`${s}-${gen}`}>
              <div className="mig-tree-row depth-1 clickable" onClick={() => setOpen((o) => ({ ...o, [s]: !o[s] }))}>
                <Icon name={open[s] ? 'chevronDown' : 'chevronRight'} size={11} className="mig-twisty" />
                <Icon name="database" size={13} className="mig-tree-ico" />
                <span className="ellipsis grow">{s}</span>
                {s === data.value.def && <span className="badge">default</span>}
              </div>
              {open[s] && <Tables sqlConnId={sqlConnId} schema={s} onAdd={onAdd} added={added} />}
            </div>
          ))}
      </div>
    </div>
  )
}
