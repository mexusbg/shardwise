import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { adviseFromProfile, coveringIndex, createIndexCommand, indexKeyDoc, suggestIndexes } from '@shared/indexAdvisor'
import type { ExistingIndex, IndexAdvice, IndexKey } from '@shared/indexAdvisor'
import type { Doc } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import './indexAdvice.css'
import { keyRowsFromDoc, openCreateIndexDialog } from '../indexes/CreateIndexDialog'

const fmt = (n: number): string => (n >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10))

function KeyChips({ keys }: { keys: IndexKey[] }): ReactElement {
  return (
    <span className="ia-keys">
      {keys.map(([f, d]) => (
        <span key={f} className="ia-key mono">
          {f}
          <b>{d === 1 ? ' ↑' : ' ↓'}</b>
        </span>
      ))}
    </span>
  )
}

function CreateIndexBody({ db, coll, keys, close }: { db: string; coll: string; keys: IndexKey[]; close: (name: string | null, opts?: { name?: string; unique?: boolean; hidden?: boolean }) => void }): ReactElement {
  const [name, setName] = useState('')
  const [unique, setUnique] = useState(false)
  const [hidden, setHidden] = useState(false)
  return (
    <Modal
      title={`Create index on ${db}.${coll}`}
      icon="key"
      onClose={() => close(null)}
      width={560}
      footer={
        <>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => close('ok', { name: name.trim() || undefined, unique, hidden })}>
            Create index
          </button>
        </>
      }
    >
      <div className="field">
        <label>Keys</label>
        <KeyChips keys={keys} />
      </div>
      <div className="field">
        <label>Name</label>
        <input className="input mono" value={name} placeholder={keys.map(([f, d]) => `${f}_${d}`).join('_')} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Options</label>
        <div className="col" style={{ gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> Unique
          </label>
          <label className="check" title="Hidden indexes are maintained but not used by the planner, so you can test the impact of dropping one">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hidden
          </label>
        </div>
      </div>
      <div className="notice">Building an index on a large collection takes time and adds load. On a busy production server, prefer a quiet period.</div>
    </Modal>
  )
}

/** Ask for options and create the index (Index Manager dialog). Returns true when it was created. */
export async function createIndexFlow(connId: string, db: string, coll: string, keys: IndexKey[]): Promise<boolean> {
  return (await openCreateIndexDialog({ connId, db, coll, keys: keyRowsFromDoc(indexKeyDoc(keys)) })) !== null
}

/** Minimal create flow kept for reference; superseded by the Index Manager dialog. */
export async function createIndexFlowSimple(connId: string, db: string, coll: string, keys: IndexKey[]): Promise<boolean> {
  let opts: { name?: string; unique?: boolean; hidden?: boolean } | undefined
  const r = await openModal<string | null>((close) => (
    <CreateIndexBody
      db={db}
      coll={coll}
      keys={keys}
      close={(v, o) => {
        opts = o
        close(v)
      }}
    />
  ))
  if (!r) return false
  try {
    const name = await api.createIndex(connId, db, coll, indexKeyDoc(keys), opts ?? {})
    toast(`Index ${name} created on ${coll}`, 'success')
    return true
  } catch (e) {
    toast(`Could not create the index: ${errorText(e)}`, 'error')
    return false
  }
}

function AdviceCard({ a, connId, db, onCreated }: { a: IndexAdvice; connId: string; db: string; onCreated: () => void }): ReactElement {
  return (
    <div className={`ia-card ${a.coveredBy ? 'covered' : ''}`}>
      <div className="ia-head">
        <Icon name="key" size={14} />
        <b>{a.coll}</b>
        <KeyChips keys={a.keys} />
        <span className="spacer" />
        {a.reasons.map((r) => (
          <span key={r} className="badge ia-reason">
            {r}
          </span>
        ))}
      </div>
      <div className="ia-stats muted">
        <span>
          <b>{fmt(a.count)}</b> run{a.count === 1 ? '' : 's'}
        </span>
        <span>
          <b>{fmt(a.totalMs)}</b> ms total
        </span>
        <span>
          <b>{fmt(a.avgMs)}</b> ms avg
        </span>
        <span>
          <b>{fmt(a.avgDocsExamined)}</b> docs examined / <b>{fmt(a.avgReturned)}</b> returned on average
        </span>
      </div>
      <div className="ia-query mono" title="Query shape">
        {a.example}
      </div>
      {a.coveredBy ? (
        <div className="ia-note">
          Index <span className="mono">{a.coveredBy}</span> already matches this query. It is slow for another reason (index not chosen, low selectivity, or data
          volume); check the Explain plan.
        </div>
      ) : (
        <div className="ia-actions">
          <code className="ia-cmd">{a.command}</code>
          <button
            className="btn small"
            onClick={async () => {
              await api.copyText(a.command)
              toast('Command copied', 'success')
            }}
          >
            <Icon name="copy" size={12} /> Copy
          </button>
          <button
            className="btn small primary"
            onClick={async () => {
              if (await createIndexFlow(connId, db, a.coll, a.keys)) onCreated()
            }}
          >
            <Icon name="plus" size={12} /> Create index
          </button>
        </div>
      )}
    </div>
  )
}

/** Index suggestions computed from the loaded system.profile entries. */
export function IndexAdvicePanel({ connId, db, entries }: { connId: string; db: string; entries: Doc[] }): ReactElement {
  const [indexes, setIndexes] = useState<Record<string, ExistingIndex[]>>({})
  const [rev, setRev] = useState(0)
  const colls = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) if (typeof e.ns === 'string' && e.ns.startsWith(`${db}.`)) set.add(e.ns.slice(db.length + 1))
    return [...set].filter((c) => !c.startsWith('system.'))
  }, [entries, db])

  useEffect(() => {
    let alive = true
    Promise.all(colls.map(async (c) => [c, await api.listIndexes(connId, db, c).catch(() => [])] as const)).then((pairs) => {
      if (alive) setIndexes(Object.fromEntries(pairs.map(([c, list]) => [c, list.map((i) => ({ name: i.name, key: i.key }))])))
    })
    return () => {
      alive = false
    }
  }, [colls, connId, db, rev])

  const advice = useMemo(() => adviseFromProfile(entries, indexes), [entries, indexes])
  const open = advice.filter((a) => !a.coveredBy)

  if (!advice.length)
    return (
      <div className="pf-none muted ia-empty">
        <Icon name="check" size={28} />
        <div>No index suggestions for the recorded operations.</div>
        <div className="faint">Suggestions appear for query shapes that scan the collection, sort in memory or examine far more documents than they return.</div>
      </div>
    )

  return (
    <div className="ia-list">
      <div className="ia-intro muted">
        {open.length} suggestion{open.length === 1 ? '' : 's'} from {entries.length} recorded operations, ranked by total time. Field order follows the
        Equality → Sort → Range rule.
      </div>
      {advice.map((a) => (
        <AdviceCard key={`${a.coll}|${JSON.stringify(a.keys)}`} a={a} connId={connId} db={db} onCreated={() => setRev((r) => r + 1)} />
      ))}
    </div>
  )
}

/** Suggestion card for the Explain view: shown when the explained query scans or sorts in memory. */
export function ExplainIndexHint({ connId, db, coll, filter, sort }: { connId: string; db: string; coll: string; filter: Doc; sort: Doc | null }): ReactElement | null {
  const [existing, setExisting] = useState<ExistingIndex[] | null>(null)
  const [rev, setRev] = useState(0)
  useEffect(() => {
    let alive = true
    api
      .listIndexes(connId, db, coll)
      .then((l) => alive && setExisting(l.map((i) => ({ name: i.name, key: i.key }))))
      .catch(() => alive && setExisting([]))
    return () => {
      alive = false
    }
  }, [connId, db, coll, rev])
  const suggestions = useMemo(() => suggestIndexes(filter, sort), [filter, sort])
  if (!existing || !suggestions.length) return null
  return (
    <div className="ia-hint">
      {suggestions.map(({ keys, eqCount }) => {
        const covered = coveringIndex(keys, existing, eqCount)
        const cmd = createIndexCommand(coll, keys)
        return (
          <div key={JSON.stringify(keys)} className="ia-hint-row">
            <Icon name="key" size={14} />
            {covered ? (
              <span className="muted">
                Index <span className="mono">{covered}</span> matches this query (<KeyChips keys={keys} />) but was not used efficiently.
              </span>
            ) : (
              <>
                <span>Suggested index:</span>
                <KeyChips keys={keys} />
                <span className="spacer" />
                <button className="btn small" onClick={() => api.copyText(cmd).then(() => toast('Command copied', 'success'))} title={cmd}>
                  <Icon name="copy" size={12} /> Copy command
                </button>
                <button
                  className="btn small primary"
                  onClick={async () => {
                    if (await createIndexFlow(connId, db, coll, keys)) setRev((r) => r + 1)
                  }}
                >
                  <Icon name="plus" size={12} /> Create index
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
