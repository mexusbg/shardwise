import { insertNode, ruleFromField } from '@shared/vqb/tree'
import { OPERATOR_BY_ID } from '@shared/vqb/operators'
import type { Rule } from '@shared/vqb/types'
import { getTab, patchTab } from '../../state/store'
import type { VqbState } from '../../state/store'
import { setVqb } from '../../state/queryActions'
import { useFolds } from '../../state/folds'

export * from '@shared/vqb/tree'

/** Apply a change to the tab's builder state (read fresh from the store) and sync the query text. */
export function editVqb(tabId: string, fn: (v: VqbState) => Partial<VqbState>): void {
  const v = getTab(tabId)?.vqb
  if (v) setVqb(tabId, { ...v, ...fn(v) })
}

/** Toolbar button / Mod+B: a folded builder unfolds, an open one closes, a closed one opens unfolded. */
export function toggleFilterBuilder(tabId: string): void {
  const open = getTab(tabId)?.vqbOpen
  const folds = useFolds.getState()
  if (open && folds.vqb) return folds.setFolded('vqb', false)
  if (!open) folds.setFolded('vqb', false)
  patchTab(tabId, { vqbOpen: !open })
}

/** "Add to Query Builder" / field drop: open the builder and append a rule for the field to the root group. */
export function addFieldToBuilder(tabId: string, path: string, value: unknown, hasValue: boolean): void {
  const tab = getTab(tabId)
  if (!tab) return
  patchTab(tabId, { vqbOpen: true })
  useFolds.getState().setFolded('vqb', false)
  const rule = seedRule(ruleFromField(path, value, hasValue, tab.docs ?? []))
  editVqb(tabId, (v) => ({ root: insertNode(v.root, v.root.id, rule), useQuery: true }))
}

/** A boolean rule without a value starts as `true`, matching what its value picker shows. */
export const seedRule = (r: Rule): Rule => (r.valueType === 'bool' && r.value === '' && OPERATOR_BY_ID[r.op].operand === 'one' ? { ...r, value: 'true' } : r)
