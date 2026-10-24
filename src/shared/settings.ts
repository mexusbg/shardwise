import type { AppSettings, EditorArea, JsonStyle, ResultViewKind } from './api'
import { toCollation } from './collation'
import type { Collation } from './collation'
import { DEFAULT_PROXY_SETTINGS, normalizeProxySettings } from './proxy'
import { normalizeShellSettings, SHELL_DEFAULTS } from './shellOptions'
import { COMMANDS } from './commands'
import { normalizeOverrides } from './keymap'
import { normalizeValueColors } from './valueColors'

export const HISTORY_LIMIT_MIN = 100
export const HISTORY_LIMIT_MAX = 10000
export const HISTORY_LIMIT_DEFAULT = 1000

export const EDITOR_AREAS: EditorArea[] = ['query', 'pipeline', 'shell', 'sql', 'playground']
export const UI_ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
export const EDITOR_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20]

export const DEFAULT_SETTINGS: AppSettings = {
  pageSize: 50,
  toolsPath: '',
  queryTimeoutMS: 0,
  theme: 'dark',
  autoCast: true,
  restoreSession: 'ask',
  dateFormat: 'system',
  timeFormat: 'system',
  dataTimeZone: 'UTC',
  dataDateStyle: 'iso',
  runQueryOnOpen: true,
  defaultResultView: 'table',
  rememberResultView: true,
  filterBuilderOnOpen: true,
  treeExpandFirst: false,
  jsonStyle: 'shell',
  confirmSingleDelete: true,
  checkUpdates: true,
  defaultCollation: null,
  editorFontFamily: '',
  editorFontSize: 0,
  editorTabWidth: 2,
  editorCloseBrackets: true,
  editorLineWrapping: true,
  editorAutocomplete: { query: true, pipeline: true, shell: true, sql: true, playground: true },
  uiZoom: 1,
  historyLimit: HISTORY_LIMIT_DEFAULT,
  connectionManagerOnStart: true,
  proxy: DEFAULT_PROXY_SETTINGS,
  keymap: {},
  valueColors: {},
  ...SHELL_DEFAULTS
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

/** Whole number in [min, max]; anything unusable gives `fallback`. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback
}

export const clampHistoryLimit = (v: unknown): number => clampInt(v, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX, HISTORY_LIMIT_DEFAULT)

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** A valid collation document (canonical field order), else null (= none). */
export function normalizeCollation(v: unknown): Collation | null {
  try {
    return toCollation(v) ?? null
  } catch {
    return null
  }
}

/**
 * Complete settings from a stored (possibly older or hand-edited) object: missing keys get their defaults,
 * values of the wrong type or out of range are replaced. Unknown keys are kept.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AppSettings, unknown>>
  const d = DEFAULT_SETTINGS
  const ac = (r.editorAutocomplete && typeof r.editorAutocomplete === 'object' ? r.editorAutocomplete : {}) as Partial<Record<EditorArea, unknown>>
  const zoom = typeof r.uiZoom === 'number' && Number.isFinite(r.uiZoom) ? clamp(r.uiZoom, 0.5, 2) : d.uiZoom
  return {
    ...d,
    ...(r as Partial<AppSettings>),
    runQueryOnOpen: bool(r.runQueryOnOpen, d.runQueryOnOpen),
    defaultResultView: oneOf<ResultViewKind>(r.defaultResultView, ['table', 'tree', 'json'], d.defaultResultView),
    rememberResultView: bool(r.rememberResultView, d.rememberResultView),
    filterBuilderOnOpen: bool(r.filterBuilderOnOpen, d.filterBuilderOnOpen),
    treeExpandFirst: bool(r.treeExpandFirst, d.treeExpandFirst),
    jsonStyle: oneOf<JsonStyle>(r.jsonStyle, ['shell', 'relaxed', 'canonical'], d.jsonStyle),
    confirmSingleDelete: bool(r.confirmSingleDelete, d.confirmSingleDelete),
    checkUpdates: bool(r.checkUpdates, d.checkUpdates),
    defaultCollation: normalizeCollation(r.defaultCollation),
    editorFontFamily: typeof r.editorFontFamily === 'string' ? r.editorFontFamily.trim() : d.editorFontFamily,
    // 0 (or less) = the built-in size of each editor.
    editorFontSize: typeof r.editorFontSize === 'number' && r.editorFontSize <= 0 ? 0 : clampInt(r.editorFontSize, 8, 32, d.editorFontSize),
    editorTabWidth: clampInt(r.editorTabWidth, 1, 8, d.editorTabWidth),
    editorCloseBrackets: bool(r.editorCloseBrackets, d.editorCloseBrackets),
    editorLineWrapping: bool(r.editorLineWrapping, d.editorLineWrapping),
    editorAutocomplete: Object.fromEntries(EDITOR_AREAS.map((a) => [a, bool(ac[a], d.editorAutocomplete[a])])) as Record<EditorArea, boolean>,
    uiZoom: zoom,
    historyLimit: clampHistoryLimit(r.historyLimit),
    connectionManagerOnStart: bool(r.connectionManagerOnStart, d.connectionManagerOnStart),
    proxy: normalizeProxySettings(r.proxy),
    keymap: normalizeOverrides(r.keymap, COMMANDS),
    valueColors: normalizeValueColors(r.valueColors),
    ...normalizeShellSettings(r)
  }
}
