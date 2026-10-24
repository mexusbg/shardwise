import type { ReactElement, ReactNode } from 'react'
import { DEFAULT_PROXY_PORTS, PROXY_TYPE_LABELS } from '@shared/proxy'
import type { ProxyType } from '@shared/proxy'

export interface ProxyServerValue {
  type: ProxyType
  host: string
  port: number
  username: string
}

/** One labelled row; `pref` lets the Settings search scroll to it. */
export function ProxyField({ label, pref, hint, top, children }: { label: ReactNode; pref?: string; hint?: ReactNode; top?: boolean; children: ReactNode }): ReactElement {
  return (
    <div className={`field ${top ? 'top' : ''}`} data-pref={pref}>
      <label>{label}</label>
      <div style={{ minWidth: 0 }}>
        <div className="row">{children}</div>
        {hint && <div className="pref-hint">{hint}</div>}
      </div>
    </div>
  )
}

/**
 * Type / host / port / user name / password of a proxy server (Settings → Network & tools and a connection's
 * Proxy tab). The password field is write-only: `passwordSaved` shows that one is stored.
 */
export function ProxyServerFields({
  value,
  onChange,
  password,
  onPassword,
  passwordSaved,
  onClearPassword,
  prefIds
}: {
  value: ProxyServerValue
  onChange: (v: ProxyServerValue) => void
  password: string
  onPassword: (v: string) => void
  passwordSaved?: boolean
  onClearPassword?: () => void
  /** data-pref ids for the Settings search (server, credentials). */
  prefIds?: { server: string; credentials: string }
}): ReactElement {
  const setType = (type: ProxyType): void => {
    // Switching type moves a default port along with it.
    const port = value.port === DEFAULT_PROXY_PORTS[value.type] ? DEFAULT_PROXY_PORTS[type] : value.port
    onChange({ ...value, type, port })
  }
  return (
    <>
      <ProxyField label="Proxy type" pref={prefIds && 'proxyType'}>
        <div className="segmented">
          {(Object.keys(PROXY_TYPE_LABELS) as ProxyType[]).map((t) => (
            <button key={t} className={value.type === t ? 'on' : ''} onClick={() => setType(t)}>
              {PROXY_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </ProxyField>
      <ProxyField label="Proxy server" pref={prefIds?.server}>
        <input
          className="input grow mono"
          value={value.host}
          placeholder="proxy.example.com"
          spellCheck={false}
          aria-label="Proxy host"
          onChange={(e) => onChange({ ...value, host: e.target.value.trim() })}
        />
        <span className="faint">:</span>
        <input
          className="input mono"
          style={{ width: 76 }}
          inputMode="numeric"
          aria-label="Proxy port"
          value={value.port || ''}
          onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, '').slice(0, 5)) || 0 })}
        />
      </ProxyField>
      <ProxyField label="User name" pref={prefIds?.credentials} hint="Leave empty when the proxy needs no authentication. HTTP proxies get Basic authentication.">
        <input className="input grow" value={value.username} autoComplete="off" spellCheck={false} onChange={(e) => onChange({ ...value, username: e.target.value })} />
      </ProxyField>
      <ProxyField label="Password">
        <input
          className="input grow"
          type="password"
          autoComplete="off"
          value={password}
          placeholder={passwordSaved ? 'Saved (encrypted) — type to replace' : ''}
          disabled={!value.username}
          onChange={(e) => onPassword(e.target.value)}
        />
        {passwordSaved && !password && onClearPassword && (
          <button className="btn" onClick={onClearPassword}>
            Remove
          </button>
        )}
      </ProxyField>
    </>
  )
}
