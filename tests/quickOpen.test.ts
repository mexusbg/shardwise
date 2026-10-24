import { describe, expect, it } from 'vitest'
import { rankCollections } from '@shared/quickOpen'
import type { QuickOpenItem } from '@shared/quickOpen'

const item = (db: string, coll: string): QuickOpenItem => ({ connId: 'c', connName: 'Local', db, coll, view: false })
const items = [
  item('app', 'appusers'),
  item('app', 'permissions'),
  item('app', 'orderItems'),
  item('app', 'orders'),
  item('billing', 'invoices'),
  item('billing', 'user_permissions'),
  item('app', 'system.views'),
  item('app', 'Клиенти')
]
const names = (q: string): string[] => rankCollections(items, q).map((i) => `${i.db}.${i.coll}`)

describe('Go to collection (Ctrl+P)', () => {
  it('ranks prefix matches first, then word starts, then substrings', () => {
    expect(names('perm')).toEqual(['app.permissions', 'billing.user_permissions'])
    expect(names('ord')).toEqual(['app.orders', 'app.orderItems'])
    expect(names('items')).toEqual(['app.orderItems'])
    // Substring first, then letters in order (u-s-e-r-s inside user_permissions).
    expect(names('users')).toEqual(['app.appusers', 'billing.user_permissions'])
  })

  it('matches "db.collection", letters in order, and Cyrillic', () => {
    expect(names('billing.inv')).toEqual(['billing.invoices'])
    expect(names('apus')).toEqual(['app.appusers'])
    expect(names('кли')).toEqual(['app.Клиенти'])
  })

  it('lists everything but system collections when empty', () => {
    expect(names('')).toHaveLength(7)
    expect(names('system')).toEqual(['app.system.views'])
  })
})
