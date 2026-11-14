import { describe, expect, it } from 'vitest'
import { activeMulti, clickMulti } from '@shared/treeMulti'
import { connectionStringIn, connectionTarget, newConnectionConfig, parseUri, savedTwin } from '@shared/connection'

const sib = ['c/db/a', 'c/db/b', 'c/db/c', 'c/db/d']

describe('selecting several collections in the tree', () => {
  it('Ctrl+click adds and removes collections next to the selected one', () => {
    let s = clickMulti({ selection: 'c/db/a', multi: [] }, 'c/db/c', sib, 'toggle')
    expect(s).toEqual({ selection: 'c/db/a', multi: ['c/db/a', 'c/db/c'] })
    s = clickMulti(s, 'c/db/b', sib, 'toggle')
    expect(activeMulti(s)).toEqual(['c/db/a', 'c/db/b', 'c/db/c'])
    // Removing the anchor moves the selection to a remaining one.
    s = clickMulti(s, 'c/db/a', sib, 'toggle')
    expect(s).toEqual({ selection: 'c/db/b', multi: ['c/db/b', 'c/db/c'] })
    s = clickMulti(s, 'c/db/c', sib, 'toggle')
    expect(activeMulti(s)).toEqual([])
    expect(s.selection).toBe('c/db/b')
  })

  it('Shift+click takes the run from the selected row', () => {
    expect(clickMulti({ selection: 'c/db/d', multi: [] }, 'c/db/b', sib, 'range')).toEqual({ selection: 'c/db/d', multi: ['c/db/b', 'c/db/c', 'c/db/d'] })
  })

  it('starts over in another database or from a non-collection row', () => {
    expect(clickMulti({ selection: 'c/other/x', multi: [] }, 'c/db/b', sib, 'toggle')).toEqual({ selection: 'c/db/b', multi: ['c/db/b'] })
    expect(clickMulti({ selection: 'c/db', multi: [] }, 'c/db/b', sib, 'range')).toEqual({ selection: 'c/db/b', multi: ['c/db/b'] })
  })

  it('ends when something outside it is selected', () => {
    expect(activeMulti({ selection: 'c/db/d', multi: ['c/db/a', 'c/db/b'] })).toEqual([])
  })
})

describe('connection strings on the clipboard', () => {
  it('accepts one connection string and nothing else', () => {
    expect(connectionStringIn('  mongodb+srv://u:p@cluster0.ab.mongodb.net/?retryWrites=true\n')).toBe('mongodb+srv://u:p@cluster0.ab.mongodb.net/?retryWrites=true')
    expect(connectionStringIn('mongodb://localhost:27017')).toBe('mongodb://localhost:27017')
    expect(connectionStringIn('see mongodb://localhost:27017')).toBeNull()
    expect(connectionStringIn('mongodb://a:1\nmongodb://b:2')).toBeNull()
    expect(connectionStringIn('https://example.com')).toBeNull()
    expect(connectionStringIn('')).toBeNull()
  })

  it('counts a string as saved when a connection reaches the same server with the same user', () => {
    const saved = [
      { ...parseUri('mongodb://admin@h2:27018,H1:27017/?replicaSet=rs'), id: '1' },
      { ...newConnectionConfig(), id: '2', mode: 'uri' as const, uri: 'mongodb+srv://bob@cluster0.example.net' }
    ]
    expect(savedTwin(parseUri('mongodb://admin:secret@h1:27017,h2:27018/app?replicaSet=rs'), saved)?.id).toBe('1')
    expect(savedTwin(parseUri('mongodb+srv://bob:x@CLUSTER0.example.net/?appName=y'), saved)?.id).toBe('2')
    expect(savedTwin(parseUri('mongodb://other@h1:27017,h2:27018'), saved)).toBeUndefined()
    expect(savedTwin(parseUri('mongodb://admin@h1:27017'), saved)).toBeUndefined()
    expect(connectionTarget({ ...newConnectionConfig(), mode: 'uri', uri: 'not a uri' })).toBeNull()
  })
})
