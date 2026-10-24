import type { ChangeOp, ChangeSource } from '@shared/changeHistoryApi'
import { fmtDate, fmtDateTime } from '../../lib/datetime'

export const num = (n: number): string => n.toLocaleString()

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export const fullTime = (d: Date): string => fmtDateTime(d)

export function relTime(d: Date, now = Date.now()): string {
  const s = Math.round((now - new Date(d).getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.round(h / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return fmtDate(d)
}

export const OP_LABEL: Record<ChangeOp, string> = { update: 'Update', replace: 'Replace', delete: 'Delete', insert: 'Insert', drop: 'Drop' }

export const SOURCE_LABEL: Record<ChangeSource, string> = {
  edit: 'Edit',
  bulk: 'Bulk edit',
  delete: 'Delete',
  sync: 'Diff & Sync',
  reschema: 'Restructure Fields',
  mask: 'Masking',
  mcp: 'MCP client',
  import: 'Import',
  restore: 'Restore'
}
