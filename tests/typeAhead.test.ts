import { describe, expect, it } from 'vitest'
import { typeAheadTarget } from '@shared/typeAhead'
import type { TypeAheadItem } from '@shared/typeAhead'

const db = (name: string): TypeAheadItem => ({ key: `c1/${name}`, parent: 'c1', name })
const coll = (dbName: string, name: string): TypeAheadItem => ({ key: `c1/${dbName}/${name}`, parent: `c1/${dbName}`, name })

const items: TypeAheadItem[] = [
  { key: 'c1', parent: '', name: 'Local demo' },
  db('admin'),
  db('app'),
  coll('app', 'appusers'),
  coll('app', 'orders'),
  coll('app', 'permissions'),
  coll('app', 'products'),
  coll('app', 'Пользователи'),
  db('payments'),
  coll('payments', 'payouts')
]

describe('tree type-ahead', () => {
  it('jumps to the next collection of the same database starting with the key', () => {
    expect(typeAheadTarget(items, 'c1/app/appusers', 'p')).toBe('c1/app/permissions')
  })

  it('stays inside the database: no jump to the "payments" database or its collections', () => {
    expect(typeAheadTarget(items, 'c1/app/products', 'p')).toBe('c1/app/permissions')
    expect(typeAheadTarget(items, 'c1/app/appusers', 'x')).toBeNull()
  })

  it('repeating the key cycles through the matches, wrapping around', () => {
    expect(typeAheadTarget(items, 'c1/app/permissions', 'pp')).toBe('c1/app/products')
    expect(typeAheadTarget(items, 'c1/app/products', 'ppp')).toBe('c1/app/permissions')
  })

  it('a longer prefix narrows the match and may keep the current row', () => {
    expect(typeAheadTarget(items, 'c1/app/appusers', 'pr')).toBe('c1/app/products')
    expect(typeAheadTarget(items, 'c1/app/products', 'pro')).toBe('c1/app/products')
  })

  it('ignores case and handles Cyrillic names', () => {
    expect(typeAheadTarget(items, 'c1/app/appusers', 'P')).toBe('c1/app/permissions')
    expect(typeAheadTarget(items, 'c1/app/appusers', 'п')).toBe('c1/app/Пользователи')
  })

  it('moves between databases when a database row is selected', () => {
    expect(typeAheadTarget(items, 'c1/admin', 'p')).toBe('c1/payments')
    expect(typeAheadTarget(items, 'c1/payments', 'a')).toBe('c1/admin')
  })

  it('without a selection searches the top level', () => {
    expect(typeAheadTarget(items, null, 'l')).toBe('c1')
    expect(typeAheadTarget(items, null, '')).toBeNull()
  })
})
