import { docText } from '@shared/docText'
import { useStore } from '../state/store'

/** Document text in the JSON style chosen in Settings → Browsing data (for copy actions). */
export const prefDocText = (v: unknown, indent = 2): string => {
  const s = useStore.getState().settings
  return docText(v, s.jsonStyle, indent, s.jsonNumbers)
}

/** Shell-syntax text for the document editors, with numbers as Settings → Browsing data → Numbers shows them. */
export const editorDocText = (v: unknown, indent = 2): string => docText(v, 'shell', indent, useStore.getState().settings.jsonNumbers)
