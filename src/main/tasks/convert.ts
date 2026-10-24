import type { MaskTarget } from '@shared/maskingApi'
import type { SavedMaskTarget, TaskJob, TaskJobInput } from '@shared/tasksApi'

/** Live request → saved request: every connection id replaced by its saved connection's config id. */
export function toSavedJob(j: TaskJobInput, configOf: (connId: string) => string): TaskJob {
  const swap = <T extends { connId: string }>(x: T): Omit<T, 'connId'> & { configId: string } => {
    const { connId, ...rest } = x
    return { ...rest, configId: configOf(connId) }
  }
  switch (j.kind) {
    case 'export':
      return { kind: 'export', request: swap(j.request) }
    case 'import':
      return { kind: 'import', request: swap(j.request) }
    case 'sqlExport':
      return { kind: 'sqlExport', request: swap(j.request) }
    case 'sqlImport':
      return { kind: 'sqlImport', request: swap(j.request) }
    case 'compareSync': {
      const { compare, sync, dryRun } = j.request
      return { kind: 'compareSync', request: { compare: { ...compare, source: swap(compare.source), target: swap(compare.target) }, sync: { ...sync }, dryRun } }
    }
    case 'mask': {
      const t = j.request.target
      const target: SavedMaskTarget = t.kind === 'collection' ? swap(t) : { ...t }
      return { kind: 'mask', request: { source: swap(j.request.source), rules: j.request.rules, salt: j.request.salt, target } }
    }
  }
}

/** Saved request → live request. */
export function toLiveJob(j: TaskJob, connOf: (configId: string) => string): TaskJobInput {
  const swap = <T extends { configId: string }>(x: T): Omit<T, 'configId'> & { connId: string } => {
    const { configId, ...rest } = x
    return { ...rest, connId: connOf(configId) }
  }
  switch (j.kind) {
    case 'export':
      return { kind: 'export', request: swap(j.request) }
    case 'import':
      return { kind: 'import', request: swap(j.request) }
    case 'sqlExport':
      return { kind: 'sqlExport', request: swap(j.request) }
    case 'sqlImport':
      return { kind: 'sqlImport', request: swap(j.request) }
    case 'compareSync': {
      const { compare, sync, dryRun } = j.request
      return { kind: 'compareSync', request: { compare: { ...compare, source: swap(compare.source), target: swap(compare.target) }, sync: { ...sync }, dryRun } }
    }
    case 'mask': {
      const t = j.request.target
      const target: MaskTarget = t.kind === 'collection' ? swap(t) : { ...t }
      return { kind: 'mask', request: { source: swap(j.request.source), rules: j.request.rules, salt: j.request.salt, target } }
    }
  }
}

/** Saved connections a task uses, in order, without duplicates. */
export function jobConfigIds(j: TaskJob): string[] {
  const ids: string[] = []
  switch (j.kind) {
    case 'compareSync':
      ids.push(j.request.compare.source.configId, j.request.compare.target.configId)
      break
    case 'mask':
      ids.push(j.request.source.configId)
      if (j.request.target.kind === 'collection') ids.push(j.request.target.configId)
      break
    default:
      ids.push(j.request.configId)
  }
  return [...new Set(ids)]
}
