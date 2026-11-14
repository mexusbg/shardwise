import { useEffect } from 'react'
import { stripUriPassword } from '@shared/connection'
import { api } from '../../lib/api'
import { reloadConnections, useStore } from '../../state/store'
import { confirmDialog } from '../Modal'
import { editConnection } from './ConnectionEditor'

/** Connection strings already offered in this session (declined or not): each is asked about once until the app restarts. */
const offered = new Set<string>()
let busy = false

/** Dialogs the offer may appear over: none, or only the Connection Manager (not, say, the editor the string is being pasted into). */
const canInterrupt = (): boolean => [...document.querySelectorAll<HTMLElement>('.modal')].every((m) => m.dataset.modal === 'connection-manager')

/**
 * Offers to add the connection string on the clipboard, when there is one that no saved connection already reaches.
 * Yes opens the new-connection editor filled in from it.
 */
export async function offerClipboardConnection(): Promise<void> {
  if (busy || !useStore.getState().settings.clipboardConnections || !document.hasFocus() || !canInterrupt()) return
  busy = true
  try {
    const found = await api.clipboardConnection()
    if (!found || offered.has(found.uri) || !canInterrupt()) return
    offered.add(found.uri)
    const add = await confirmDialog({
      title: 'Add connection from the clipboard?',
      message: (
        <>
          The clipboard holds a connection string that is not saved yet:
          <div className="mono selectable clip-conn-uri">{stripUriPassword(found.uri)}</div>
          Add it as a new connection? You can check the settings before saving.
        </>
      ),
      confirmLabel: 'Add connection…'
    })
    if (add && (await editConnection(found.config))) await reloadConnections()
  } catch {
    // The clipboard can be unreadable or hold something odd: nothing to offer then.
  } finally {
    busy = false
  }
}

/** Looks at the clipboard when the window gets focus (and shortly after launch). */
export function useClipboardConnections(): void {
  useEffect(() => {
    const check = (): void => void offerClipboardConnection()
    // After launch, once settings, the restored session and the start-up dialogs have settled.
    const first = setTimeout(check, 1500)
    window.addEventListener('focus', check)
    return () => {
      clearTimeout(first)
      window.removeEventListener('focus', check)
    }
  }, [])
}
