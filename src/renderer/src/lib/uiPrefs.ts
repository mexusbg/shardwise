import type { AppSettings } from '@shared/api'
import { setEditorPrefs } from './editorPrefs'

/** CSS font-family value for a user-entered font name or list; null for an empty or unusable value. */
export function fontFamilyCss(input: string): string | null {
  const v = input.replace(/[;{}<>\\]/g, '').trim()
  if (!v) return null
  // A single bare name ("Fira Code") is quoted; lists and quoted names are used as written.
  const list = /[,'"]/.test(v) ? v : `'${v}'`
  return `${list}, var(--mono)`
}

/** Apply the interface parts of the preferences: editor font, editor behaviour and window zoom. */
export function applyUiSettings(s: AppSettings): void {
  const root = document.documentElement
  const family = fontFamilyCss(s.editorFontFamily ?? '')
  if (family) root.style.setProperty('--editor-font', family)
  else root.style.removeProperty('--editor-font')
  if (s.editorFontSize > 0) {
    root.style.setProperty('--editor-fs', `${s.editorFontSize}px`)
    root.classList.add('editor-fs-custom')
  } else {
    root.style.removeProperty('--editor-fs')
    root.classList.remove('editor-fs-custom')
  }
  setEditorPrefs(s)
  try {
    window.bridge.setZoomFactor?.(s.uiZoom > 0 ? s.uiZoom : 1)
  } catch {
    // Zoom is cosmetic.
  }
}
