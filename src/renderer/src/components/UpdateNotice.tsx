import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { UpdateInfo } from '@shared/updates'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { Icon } from './Icon'

const DISMISSED = 'shardwise.update.dismissed'
const ANNOUNCED = 'shardwise.update.announced'
/** After launch, so the check never competes with opening the window and the saved session. */
const DELAY_MS = 3_000
/** Again while the app stays open, so a window left running for days still hears of new versions. */
const RECHECK_MS = 6 * 60 * 60 * 1000

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Then it only lasts for this launch.
  }
}

/**
 * New version available (Settings → About allows the check): a card in the corner the first time a version is
 * found, and a link in the status bar on every launch until dismissed for that version.
 */
export function UpdateNotice(): ReactElement | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [card, setCard] = useState(false)

  useEffect(() => {
    const check = (): void => {
      if (!useStore.getState().settings.checkUpdates) return
      api.checkForUpdates().then(
        (r) => {
          if (r.status !== 'available' || !r.latest || r.latest === read(DISMISSED)) return
          setInfo(r)
          setCard(r.latest !== read(ANNOUNCED))
        },
        () => {}
      )
    }
    const t = setTimeout(check, DELAY_MS)
    const every = setInterval(check, RECHECK_MS)
    return () => {
      clearTimeout(t)
      clearInterval(every)
    }
  }, [])

  if (!info?.url) return null
  const href = info.download?.url ?? info.url
  const closeCard = (): void => {
    write(ANNOUNCED, info.latest ?? '')
    setCard(false)
  }
  return (
    <>
      <span className="update-notice">
        <a href={href} target="_blank" rel="noreferrer" title={`You have ${info.current}. ${info.download ? `Downloads ${info.download.name}.` : 'Opens the release page to download it.'}`}>
          <Icon name="import" size={12} /> Shardwise {info.latest} is available
        </a>
        <button
          className="btn ghost icon small"
          title="Hide until the next version"
          onClick={() => {
            write(DISMISSED, info.latest ?? '')
            closeCard()
            setInfo(null)
          }}
        >
          <Icon name="close" size={11} />
        </button>
      </span>
      {card && (
        <div className="update-card" role="status">
          <Icon name="import" size={18} className="update-card-icon" />
          <div className="update-card-text">
            <b>Shardwise {info.latest} is available</b>
            <span className="muted">
              You have {info.current}. Install the new version over this one; settings and connections are kept.{' '}
              <a href={info.url} target="_blank" rel="noreferrer">
                What&apos;s new
              </a>
            </span>
          </div>
          <div className="update-card-actions">
            <button className="btn small" onClick={closeCard}>
              Later
            </button>
            <a className="btn primary small" href={href} target="_blank" rel="noreferrer" title={info.download?.name} onClick={closeCard}>
              Download
            </a>
          </div>
        </div>
      )}
    </>
  )
}
