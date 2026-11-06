import { describe, expect, it } from 'vitest'
import { connectionTooltip, newConnectionConfig, oneLine } from '@shared/connection'
import { exportConnections, parseConnectionImport } from '../src/main/connectionTransfer'

const base = { ...newConnectionConfig(), id: 'a', name: 'Billing', hosts: [{ host: 'db1.example.net', port: 27017 }] }

describe('connection comment', () => {
  it('leads the tooltip and falls back to name and address', () => {
    expect(connectionTooltip(base)).toBe('Billing · db1.example.net:27017')
    expect(connectionTooltip({ ...base, comment: '  Production billing, read with care  ' })).toBe('Production billing, read with care\n\nBilling · db1.example.net:27017')
    expect(connectionTooltip({ ...base, comment: '   ' })).toBe('Billing · db1.example.net:27017')
  })

  it('shows on one line in the Connection Manager', () => {
    expect(oneLine('First line\n  second line\n\nthird')).toBe('First line · second line · third')
  })

  it('travels with a Shardwise export', () => {
    const text = exportConnections([{ ...base, comment: 'Billing DB' }], { format: 'shardwise', includePasswords: false })
    expect(parseConnectionImport(text).connections[0].comment).toBe('Billing DB')
  })
})
