import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { UpdateInfo } from '@shared/updates'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { Icon } from './Icon'

const DISMISSED = 'shardwise.update.dismissed'
/** After launch, so the check never competes with opening connections. */
const DELAY_MS = 10_000

const dismissedVersion = (): string | null => {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

/** Status bar: "Shardwise 0.3.0 is available" once per launch when Settings → About allows the check. */
export function UpdateNotice(): ReactElement | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      if (!useStore.getState().settings.checkUpdates) return
      api.checkForUpdates().then(
        (r) => r.status === 'available' && r.latest !== dismissedVersion() && setInfo(r),
        () => {}
      )
    }, DELAY_MS)
    return () => clearTimeout(t)
  }, [])

  if (!info?.url) return null
  return (
    <span className="update-notice">
      <a href={info.url} target="_blank" rel="noreferrer" title={`You have ${info.current}. Opens the release page to download it.`}>
        <Icon name="import" size={12} /> Shardwise {info.latest} is available
      </a>
      <button
        className="btn ghost icon small"
        title="Hide until the next version"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED, info.latest ?? '')
          } catch {
            // Only hides it for this launch then.
          }
          setInfo(null)
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </span>
  )
}
