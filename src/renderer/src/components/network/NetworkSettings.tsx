import { useState } from 'react'
import type { ReactElement } from 'react'
import type { AppSettings } from '@shared/api'
import { proxySettingsProblems } from '@shared/proxy'
import type { ProxyMode, ProxySettings, ProxyTestResult } from '@shared/proxy'
import { errorText } from '../../state/store'
import { Icon } from '../Icon'
import { proxyApi } from './proxyClient'
import { ProxyField, ProxyServerFields } from './ProxyServerFields'

const MODES: [ProxyMode, string, string][] = [
  ['none', 'No proxy', 'Connect to every server directly.'],
  ['system', 'System settings', 'Use the proxy configured in the operating system (including automatic configuration scripts).'],
  ['manual', 'Manual', 'Use the proxy server below.']
]

const DEFAULT_TARGET = 'api.anthropic.com:443'

/**
 * Settings → Network & tools: the app-wide proxy. Edits the dialog's draft (saved with its Save button); the
 * password is write-only and stored encrypted by the main process.
 */
export function NetworkSettings({ s, setS }: { s: AppSettings; setS: (s: AppSettings) => void }): ReactElement {
  const p = s.proxy
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [test, setTest] = useState<ProxyTestResult | 'running' | null>(null)

  const patch = (x: Partial<ProxySettings>): void => {
    setS({ ...s, proxy: { ...p, ...x } })
    setTest(null)
  }
  const passwordSaved = !!p.hasPassword && p.password === undefined
  // An emptied field keeps the saved password; "Remove" clears it explicitly.
  const setPassword = (v: string): void => patch({ password: v || (p.hasPassword ? undefined : '') })

  const runTest = async (): Promise<void> => {
    setTest('running')
    setTest(await proxyApi.proxyTest(p, target).catch((e): ProxyTestResult => ({ ok: false, error: errorText(e) })))
  }

  const problems = proxySettingsProblems(p)

  return (
    <div className="network-settings">
      <ProxyField label="Proxy" pref="proxyMode" hint={MODES.find(([m]) => m === p.mode)?.[2]}>
        <div className="segmented">
          {MODES.map(([m, label]) => (
            <button key={m} className={p.mode === m ? 'on' : ''} onClick={() => patch({ mode: m })}>
              {label}
            </button>
          ))}
        </div>
      </ProxyField>

      {p.mode === 'manual' && (
        <ProxyServerFields
          value={p}
          onChange={(v) => patch(v)}
          password={p.password ?? ''}
          onPassword={setPassword}
          passwordSaved={passwordSaved}
          onClearPassword={() => patch({ password: '', hasPassword: false })}
          prefIds={{ server: 'proxyServer', credentials: 'proxyCredentials' }}
        />
      )}

      {p.mode === 'system' && (
        <>
          <ProxyField label="User name" pref="proxyCredentials" hint="Only needed when the system proxy asks for a user name and password (Basic authentication).">
            <input className="input grow" value={p.username} autoComplete="off" spellCheck={false} onChange={(e) => patch({ username: e.target.value })} />
          </ProxyField>
          <ProxyField label="Password">
            <input
              className="input grow"
              type="password"
              autoComplete="off"
              value={p.password ?? ''}
              placeholder={passwordSaved ? 'Saved (encrypted) — type to replace' : ''}
              disabled={!p.username}
              onChange={(e) => setPassword(e.target.value)}
            />
            {passwordSaved && (
              <button className="btn" onClick={() => patch({ password: '', hasPassword: false })}>
                Remove
              </button>
            )}
          </ProxyField>
        </>
      )}

      {p.mode !== 'none' && (
        <ProxyField
          label="Bypass for"
          pref="proxyBypass"
          top
          hint={
            <>
              One per line or comma separated: host names (<code>db.example.com</code>), domains with sub-domains (<code>.example.com</code>), wildcards (
              <code>*.svc.local</code>, <code>db-*</code>), IP addresses and ranges (<code>10.0.0.0/8</code>), <code>&lt;local&gt;</code> for names
              without a dot; add <code>:port</code> to limit a rule to one port. Local addresses (localhost, 127.0.0.1, ::1) never use the proxy.
            </>
          }
        >
          <textarea
            className="input grow mono"
            rows={3}
            spellCheck={false}
            value={p.bypass}
            placeholder={'.internal.example.com\n10.0.0.0/8'}
            onChange={(e) => patch({ bypass: e.target.value })}
          />
        </ProxyField>
      )}

      {problems.length > 0 && (
        <div className="field">
          <label />
          <span className="error-text" style={{ fontSize: 12 }}>
            {problems.join(' ')}
          </span>
        </div>
      )}

      <ProxyField label="Test" pref="proxyTest" hint="Opens a connection to this address with the settings above (not yet saved) and closes it again.">
        <input
          className="input grow mono"
          value={target}
          spellCheck={false}
          aria-label="Address to test"
          placeholder="host:port"
          onChange={(e) => {
            setTarget(e.target.value)
            setTest(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void runTest()}
        />
        <button className="btn" onClick={() => void runTest()} disabled={test === 'running' || problems.length > 0 || !target.trim()}>
          {test === 'running' ? 'Testing…' : 'Test'}
        </button>
      </ProxyField>
      {test && test !== 'running' && (
        <div className="field">
          <label />
          <span className={test.ok ? 'proxy-test ok' : 'proxy-test error-text'} style={{ fontSize: 12 }}>
            <Icon name={test.ok ? 'check' : 'warn'} size={12} style={{ verticalAlign: -2, color: test.ok ? 'var(--ok)' : undefined }} />{' '}
            {test.ok ? `Reached ${target.trim()} — ${test.route}, ${test.ms} ms.` : `${test.route ? `${test.route}: ` : ''}${test.error}`}
          </span>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 14 }}>
        What uses it
      </div>
      <div className="faint" style={{ fontSize: 12, lineHeight: 1.6 }}>
        MongoDB connections (or their SSH tunnel), SQL connections, AI requests and the Database Tools download. A connection can pick its own proxy or
        none (connection settings → Proxy). Changes apply to connections opened afterwards.
        <br />
        For <code>mongodb+srv://</code> addresses the SRV and TXT lookups use the normal DNS; server names are resolved by the proxy. Proxies that need
        NTLM or Kerberos sign-in are not supported.
      </div>
    </div>
  )
}
