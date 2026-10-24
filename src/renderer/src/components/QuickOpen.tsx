import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { CollectionInfo } from '@shared/api'
import { rankCollections } from '@shared/quickOpen'
import type { QuickOpenItem } from '@shared/quickOpen'
import { api } from '../lib/api'
import { collKey, dbKey, openCollectionTab, useStore } from '../state/store'
import { Icon } from './Icon'
import { Modal, openModal } from './Modal'

const SHOWN = 100

/** Ctrl+P: find a collection or view of any open connection by name; Enter opens the highlighted one. */
export function openQuickOpen(): void {
  void openModal<void>((close) => <QuickOpen onDone={() => close()} />)
}

function QuickOpen({ onDone }: { onDone: () => void }): ReactElement {
  const live = useStore((s) => s.live)
  const known = useStore((s) => s.collections)
  // Databases never expanded in the tree: listed here only (no counts, no tree change).
  const [fetched, setFetched] = useState<Record<string, CollectionInfo[]>>({})
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    for (const l of Object.values(live))
      for (const d of l.databases ?? []) {
        const k = dbKey(l.connId, d.name)
        if (useStore.getState().collections[k]) continue
        api.listCollections(l.connId, d.name).then(
          (list) => alive && setFetched((f) => ({ ...f, [k]: list })),
          () => {}
        )
      }
    return () => {
      alive = false
    }
  }, [live])

  const items = useMemo(() => {
    const out: QuickOpenItem[] = []
    for (const l of Object.values(live))
      for (const d of l.databases ?? []) {
        const k = dbKey(l.connId, d.name)
        for (const c of known[k] ?? fetched[k] ?? []) out.push({ connId: l.connId, connName: l.name, db: d.name, coll: c.name, view: c.type === 'view' })
      }
    return out
  }, [live, known, fetched])
  const matches = useMemo(() => rankCollections(items, q), [items, q])
  const shown = matches.slice(0, SHOWN)
  const multiConn = Object.keys(live).length > 1

  useEffect(() => {
    setHi(0)
  }, [q])
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const open = (it: QuickOpenItem | undefined): void => {
    if (!it) return
    onDone()
    openCollectionTab(it.connId, it.db, it.coll, it.view)
    useStore.setState({ treeSelection: collKey(it.connId, it.db, it.coll) })
  }

  return (
    <Modal title="Go to collection" icon="search" onClose={onDone} width={600}>
      <input
        className="input"
        autoFocus
        style={{ width: '100%' }}
        placeholder="Collection name, or database.collection"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = shown.length
            if (n) setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            open(shown[hi])
          }
        }}
      />
      <div className="qo-list" ref={listRef} role="listbox">
        {shown.map((it, i) => (
          <div
            key={`${it.connId}/${it.db}/${it.coll}`}
            role="option"
            aria-selected={i === hi}
            className={`qo-row${i === hi ? ' active' : ''}`}
            onMouseMove={() => setHi(i)}
            onClick={() => open(it)}
          >
            <Icon name={it.view ? 'view' : 'collection'} size={13} />
            <span className="qo-name ellipsis">{it.coll}</span>
            <span className="qo-where faint ellipsis">
              {it.db}
              {multiConn ? ` · ${it.connName}` : ''}
            </span>
          </div>
        ))}
        {!shown.length && <div className="faint qo-empty">{items.length ? 'No matching collections' : 'Connect to a server to search its collections'}</div>}
      </div>
      {matches.length > SHOWN && <div className="faint qo-more">{(matches.length - SHOWN).toLocaleString()} more — keep typing to narrow down</div>}
    </Modal>
  )
}
