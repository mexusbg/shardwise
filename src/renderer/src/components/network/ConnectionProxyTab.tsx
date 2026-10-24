import type { ReactElement } from 'react'
import type { ConnectionConfig } from '@shared/connection'
import { DEFAULT_PROXY_PORTS, describeEndpoint } from '@shared/proxy'
import type { ConnProxyConfig, ProxySettings } from '@shared/proxy'
import { useStore } from '../../state/store'
import { ProxyField, ProxyServerFields } from './ProxyServerFields'

const MODES: [ConnProxyConfig['mode'], string][] = [
  ['default', 'App default'],
  ['direct', 'No proxy'],
  ['custom', 'Custom']
]

function appDefaultLabel(p: ProxySettings | undefined): string {
  if (!p || p.mode === 'none') return 'Settings → Network & tools: no proxy (direct).'
  if (p.mode === 'system') return 'Settings → Network & tools: the operating system proxy settings.'
  return `Settings → Network & tools: ${p.host ? describeEndpoint(p) : 'manual proxy (no host set)'}${p.bypass.trim() ? ', with a bypass list' : ''}.`
}

/** Connection editor → Proxy: app default, direct, or a proxy of its own (never part of the connection string). */
export function ConnectionProxyTab({ c, setC }: { c: ConnectionConfig; setC: (f: (c: ConnectionConfig) => ConnectionConfig) => void }): ReactElement {
  const appProxy = useStore((st) => st.settings.proxy)
  const p: ConnProxyConfig = c.proxy ?? { mode: 'default' }
  const patch = (x: Partial<ConnProxyConfig>): void =>
    setC((cur) => {
      const next: ConnProxyConfig = { ...(cur.proxy ?? { mode: 'default' }), ...x }
      // Nothing to remember for the default: keep saved configs (and exports) unchanged.
      return { ...cur, proxy: next.mode === 'default' && !next.host ? undefined : next }
    })
  const type = p.type ?? 'http'
  const server = { type, host: p.host ?? '', port: p.port ?? DEFAULT_PROXY_PORTS[type], username: p.username ?? '' }

  return (
    <>
      <ProxyField label="Proxy">
        <div className="segmented">
          {MODES.map(([m, label]) => (
            <button key={m} className={p.mode === m ? 'on' : ''} onClick={() => patch({ mode: m, ...(m === 'custom' && !p.type ? { type: 'http', port: DEFAULT_PROXY_PORTS.http } : {}) })}>
              {label}
            </button>
          ))}
        </div>
      </ProxyField>
      <div className="field">
        <label />
        <span className="faint" style={{ fontSize: 12 }}>
          {p.mode === 'default' ? appDefaultLabel(appProxy) : p.mode === 'direct' ? 'Always connect directly, whatever Settings → Network & tools says.' : 'Only this connection uses the proxy below.'}
        </span>
      </div>
      {p.mode === 'custom' && (
        <ProxyServerFields
          value={server}
          onChange={(v) => patch({ type: v.type, host: v.host || undefined, port: v.port || undefined, username: v.username || undefined })}
          password={p.password ?? ''}
          onPassword={(v) => patch({ password: v || undefined })}
        />
      )}
      <div className="field top">
        <label />
        <div className="faint" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {c.ssh.enabled
            ? 'With an SSH tunnel the proxy carries the SSH connection; MongoDB traffic then runs inside SSH.'
            : 'MongoDB traffic to every member is tunnelled through the proxy (HTTP CONNECT or SOCKS5); server names are resolved by the proxy.'}{' '}
          {c.mode === 'srv' && 'SRV and TXT lookups for mongodb+srv:// still use the normal DNS. '}
          Proxy settings are not part of the connection string; they are included in Shardwise exports (the password only in password-protected exports).
        </div>
      </div>
    </>
  )
}
