import type { Doc } from './api'
import { isPlainDoc } from './bsonValue'

/** Stages an update pipeline may use (MongoDB rejects the others). */
const PIPELINE_STAGES = new Set(['$addFields', '$set', '$project', '$unset', '$replaceRoot', '$replaceWith'])

/** What is wrong with the update of the Update Documents dialog, or null when it can run. */
export function updateProblem(update: unknown, pipeline: boolean): string | null {
  if (pipeline) {
    if (!Array.isArray(update)) return 'An aggregation pipeline is an array of stages: [ { $set: { … } } ]'
    if (!update.length) return 'The pipeline is empty'
    for (const stage of update) {
      const keys = isPlainDoc(stage) ? Object.keys(stage) : []
      if (keys.length !== 1) return 'Each pipeline stage is an object with one stage name, e.g. { $set: { … } }'
      if (!PIPELINE_STAGES.has(keys[0])) return `${keys[0]} cannot be used in an update pipeline (use ${[...PIPELINE_STAGES].join(', ')})`
    }
    return null
  }
  if (Array.isArray(update)) return 'This is a pipeline: choose "Aggregation pipeline" as the update mode'
  if (!isPlainDoc(update)) return 'The update must be a document such as { $set: { field: value } }'
  const keys = Object.keys(update)
  if (!keys.length) return 'The update is empty'
  const plain = keys.find((k) => !k.startsWith('$'))
  if (plain) return `"${plain}" is not an update operator: use update operators such as { $set: { ${plain}: … } }`
  return null
}

/** Filter matching the selected documents. */
export const idsFilter = (ids: unknown[]): Doc => (ids.length === 1 ? { _id: ids[0] } : { _id: { $in: ids } })
