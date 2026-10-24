import { docText } from '@shared/docText'
import { useStore } from '../state/store'

/** Document text in the JSON style chosen in Settings → Browsing data (for copy actions). */
export const prefDocText = (v: unknown, indent = 2): string => docText(v, useStore.getState().settings.jsonStyle, indent)
