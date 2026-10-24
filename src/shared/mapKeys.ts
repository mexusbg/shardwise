/**
 * Objects whose keys are data rather than field names (`{ perms: { <user id>: … } }`, values keyed by date…).
 * Treating every key as a field turns a sample into tens of thousands of fields: schema analysis merges such
 * keys into one `*` field, Migrate to SQL stores the object as one JSON column.
 */

/** More distinct keys than this: always a map. */
export const MAP_MAX_KEYS = 500
/** More distinct keys than this: a map when a typical object has far fewer keys than were seen in total. */
export const MAP_MIN_KEYS = 50

/** `objects` values were seen, holding `keysTotal` keys together, `distinctKeys` of them different. */
export function isMapLike(distinctKeys: number, objects: number, keysTotal: number): boolean {
  if (distinctKeys > MAP_MAX_KEYS) return true
  return distinctKeys > MAP_MIN_KEYS && objects > 0 && distinctKeys > (4 * keysTotal) / objects
}
