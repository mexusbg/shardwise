import type { Doc } from './api'
import { OUTPUT_STAGES, formatValue, newStage, pipelineDocs } from './pipeline'
import type { Stage } from './pipeline'
import { shellText } from './bsonValue'

/** Editor stages of a stored pipeline (e.g. a view definition). */
export function stagesFromDocs(pipeline: readonly Doc[]): Stage[] {
  return pipeline.map((st, i) => {
    const keys = Object.keys(st)
    if (keys.length !== 1 || !keys[0].startsWith('$')) throw new Error(`Stage ${i + 1} must have exactly one $operator key`)
    return newStage(keys[0], formatValue(st[keys[0]]))
  })
}

/** Comparable text of the enabled stages; null when a stage does not parse. */
export function pipelineKey(stages: Stage[]): string | null {
  try {
    return shellText(pipelineDocs(stages))
  } catch {
    return null
  }
}

/** Why the enabled stages cannot define a view, or null. */
export function viewPipelineError(stages: Stage[]): string | null {
  const out = stages.find((s) => s.enabled && OUTPUT_STAGES.has(s.op))
  return out ? `A view cannot contain ${out.op}: write stages are not allowed in views. Disable or remove the ${out.op} stage first.` : null
}
