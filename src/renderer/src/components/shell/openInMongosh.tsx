import { api } from '../../lib/api'
import { connName, errorText, isConnReadOnly, toast } from '../../state/store'
import { confirmDialog } from '../Modal'

/**
 * "Open in mongosh": starts the external mongosh in a terminal window, connected to this connection (and
 * database). Read-only connections are not read-only there, so the user is warned first.
 */
export async function openInMongosh(connId: string, db?: string): Promise<void> {
  if (isConnReadOnly(connId)) {
    const ok = await confirmDialog({
      title: 'Open in mongosh',
      message: (
        <>
          <b>{connName(connId)}</b> is read-only in Shardwise, but mongosh does not know that: commands typed there can change data. For a real guarantee, connect with a
          database user that only has read roles.
        </>
      ),
      confirmLabel: 'Open mongosh',
      danger: true
    })
    if (!ok) return
  }
  try {
    const r = await api.openInMongosh(connId, db)
    toast(`mongosh opened in ${r.terminal}${db ? ` (${db})` : ''}`, 'success')
    for (const n of r.notes) toast(n, 'info')
  } catch (e) {
    toast(`Could not open mongosh: ${errorText(e)}`, 'error')
  }
}
