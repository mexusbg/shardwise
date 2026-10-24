import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { AUTH_LABELS, AUTH_WITH_PASSWORD, buildUri, COMPRESSORS, parseDbList, READ_CONCERN_LEVELS, secretsToAsk, withSecrets } from '@shared/connection'
import type { AuthMechanism, ConnectionConfig, ReadConcernLevel } from '@shared/connection'
import type { TestResult } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { changesApi } from '../changes/changesClient'
import { askSecrets } from './askSecrets'
import { ConnectionProxyTab } from '../network/ConnectionProxyTab'
import { CollationForm } from '../collation/CollationPicker'
import { collationLabel } from '@shared/collation'

type TabId = 'server' | 'auth' | 'tls' | 'ssh' | 'proxy' | 'driver' | 'behavior' | 'advanced'

const COLORS = ['', '#13aa52', '#1f6feb', '#8a3ffc', '#d1242f', '#e36209', '#bf8700', '#0aa198']

function Field({ label, children, top }: { label: string; children: ReactNode; top?: boolean }): ReactElement {
  return (
    <div className={`field ${top ? 'top' : ''}`}>
      <label>{label}</label>
      <div className="row">{children}</div>
    </div>
  )
}

function FilePicker({ value, onChange, filters, placeholder }: { value?: string; onChange: (v: string) => void; filters?: { name: string; extensions: string[] }[]; placeholder?: string }): ReactElement {
  return (
    <>
      <input className="input grow" value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <button
        className="btn"
        onClick={async () => {
          const r = await api.openFile({ filters })
          if (r?.[0]) onChange(r[0])
        }}
      >
        Browse…
      </button>
    </>
  )
}

/** '' → undefined, otherwise a non-negative number (undefined for invalid input). */
const numIn = (v: string): number | undefined => {
  if (!v.trim()) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Default / On / Off. */
function TriSelect({ value, onChange, defaultLabel = 'Driver default' }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void; defaultLabel?: string }): ReactElement {
  return (
    <select className="select" value={value === undefined ? '' : value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'on')}>
      <option value="">{defaultLabel}</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  )
}

/** Number field that keeps what is typed (an invalid entry is marked, not replaced). */
function NumberInput({ value, onChange, placeholder, width }: { value?: number; onChange: (v: number | undefined) => void; placeholder?: string; width?: number }): ReactElement {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  // Outside changes (a parsed URI) replace the text; typing does not.
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    if (numIn(text) !== value) setText(value === undefined ? '' : String(value))
  }
  return (
    <input
      className={`input ${text.trim() && numIn(text) === undefined ? 'invalid' : ''} ${width ? '' : 'grow'}`}
      style={width ? { width } : undefined}
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(numIn(e.target.value))
      }}
    />
  )
}

/** Ordered read preference tag sets (`dc:east,rack:1`; an empty set matches any member). */
function TagSets({ tags, onChange, disabled }: { tags: string[]; onChange: (t: string[] | undefined) => void; disabled: boolean }): ReactElement {
  const set = (next: string[]): void => onChange(next.length ? next : undefined)
  const move = (i: number, d: number): void => {
    const next = [...tags]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x)
    set(next)
  }
  return (
    <div className="col grow" style={{ gap: 4 }}>
      {tags.map((t, i) => (
        <div className="row" key={i}>
          <span className="faint" style={{ width: 18, textAlign: 'right' }}>
            {i + 1}.
          </span>
          <input
            className="input grow mono"
            value={t}
            placeholder="empty = any member   e.g. dc:east,rack:1"
            disabled={disabled}
            onChange={(e) => set(tags.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button className="btn ghost icon small" title="Try earlier" disabled={disabled || i === 0} onClick={() => move(i, -1)}>
            <Icon name="chevronUp" size={12} />
          </button>
          <button className="btn ghost icon small" title="Try later" disabled={disabled || i === tags.length - 1} onClick={() => move(i, 1)}>
            <Icon name="chevronDown" size={12} />
          </button>
          <button className="btn ghost icon small" title="Remove tag set" disabled={disabled} onClick={() => set(tags.filter((_, j) => j !== i))}>
            <Icon name="minus" size={12} />
          </button>
        </div>
      ))}
      <div>
        <button className="link" disabled={disabled} onClick={() => set([...tags, ''])}>
          + Add tag set
        </button>
        <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>
          {disabled ? 'Choose a read preference other than primary to use tag sets.' : 'Tried in order; the first set matching a member is used.'}
        </span>
      </div>
    </div>
  )
}

const PEM = [
  { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'key'] },
  { name: 'All files', extensions: ['*'] }
]

const ASKED = 'Asked for every time you connect; never saved.'

function Editor({ initial, onDone }: { initial: ConnectionConfig; onDone: (c: ConnectionConfig | null) => void }): ReactElement {
  const [c, setC] = useState<ConnectionConfig>(initial)
  const [tab, setTab] = useState<TabId>('server')
  const [uriText, setUriText] = useState(initial.mode === 'uri' ? (initial.uri ?? '') : '')
  const [uriError, setUriError] = useState<string | null>(null)
  const [test, setTest] = useState<TestResult | 'running' | null>(null)
  const [saving, setSaving] = useState(false)
  const settings = useStore((s) => s.settings)
  const [globalHistory, setGlobalHistory] = useState<boolean | null>(null)
  const [dbText, setDbText] = useState((initial.databases?.names ?? []).join('\n'))

  useEffect(() => {
    changesApi.changesGetSettings().then(
      (h) => setGlobalHistory(h.enabled),
      () => {}
    )
  }, [])

  const patch = (p: Partial<ConnectionConfig>): void => setC((x) => ({ ...x, ...p }))
  const patchAuth = (p: Partial<ConnectionConfig['auth']>): void => setC((x) => ({ ...x, auth: { ...x.auth, ...p } }))
  const patchTls = (p: Partial<ConnectionConfig['tls']>): void => setC((x) => ({ ...x, tls: { ...x.tls, ...p } }))
  const patchSsh = (p: Partial<ConnectionConfig['ssh']>): void => setC((x) => ({ ...x, ssh: { ...x.ssh, ...p } }))
  const patchOpt = (p: Partial<ConnectionConfig['options']>): void => setC((x) => ({ ...x, options: { ...x.options, ...p } }))
  const patchWc = (p: Partial<NonNullable<ConnectionConfig['options']['writeConcern']>>): void =>
    setC((x) => {
      const wc = { ...x.options.writeConcern, ...p }
      return { ...x, options: { ...x.options, writeConcern: Object.values(wc).some((v) => v !== undefined) ? wc : undefined } }
    })
  const patchOverrides = (p: Partial<NonNullable<ConnectionConfig['overrides']>>): void =>
    setC((x) => {
      const o = { ...x.overrides, ...p }
      return { ...x, overrides: Object.values(o).some((v) => v !== undefined) ? o : undefined }
    })
  const setDbMode = (mode: 'auto' | 'manual'): void =>
    setC((x) => {
      const names = x.databases?.names
      return { ...x, databases: mode === 'manual' || names?.length ? { mode, names } : undefined }
    })
  const setDbNames = (text: string): void => {
    setDbText(text)
    const names = parseDbList(text)
    setC((x) => {
      const mode = x.databases?.mode ?? 'auto'
      return { ...x, databases: names.length || mode === 'manual' ? { mode, names: names.length ? names : undefined } : undefined }
    })
  }

  const importUri = async (): Promise<void> => {
    try {
      const parsed = await api.parseUri(uriText, c)
      setC({ ...parsed, id: c.id, name: c.name === 'New Connection' ? parsed.srvHost || parsed.hosts[0]?.host || c.name : c.name })
      setUriError(null)
      setTab('server')
    } catch (e) {
      setUriError(errorText(e))
    }
  }

  const runTest = async (): Promise<void> => {
    const secrets = await askSecrets(c)
    if (!secrets) return
    setTest('running')
    try {
      setTest(await api.testConnection(withSecrets(c, secrets)))
    } catch (e) {
      setTest({ ok: false, steps: [], error: errorText(e) })
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      onDone(await api.saveConnection(c))
    } catch (e) {
      setTest({ ok: false, steps: [], error: errorText(e) })
      setSaving(false)
    }
  }

  const needsPassword = AUTH_WITH_PASSWORD.includes(c.auth.mechanism)
  const needsUser = c.auth.mechanism !== 'none'
  const o = c.options
  const rpPrimary = (o.readPreference ?? 'primary') === 'primary'
  const sshSecret = secretsToAsk({ ...c, ssh: { ...c.ssh, enabled: true, askPassword: true } }).ssh
  let uriPreview: string
  try {
    uriPreview = buildUri(c)
  } catch (e) {
    uriPreview = errorText(e)
  }

  return (
    <Modal
      title={initial.id ? `Edit connection — ${initial.name}` : 'New connection'}
      icon="server"
      onClose={() => onDone(null)}
      width={760}
      footer={
        <>
          <button className="btn" onClick={runTest} disabled={test === 'running'}>
            <Icon name="plug" /> Test connection
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !c.name.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Connection name</label>
        <div className="row">
          <input className="input grow" value={c.name} onChange={(e) => patch({ name: e.target.value })} autoFocus />
          <div className="row" title="Colour">
            {COLORS.map((col) => (
              <button
                key={col || 'none'}
                onClick={() => patch({ color: col || undefined })}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: `2px solid ${(c.color ?? '') === col ? 'var(--text)' : 'var(--border)'}`,
                  background: col || 'transparent',
                  cursor: 'pointer',
                  padding: 0
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label>Import from URI</label>
        <div className="row">
          <input
            className={`input grow mono ${uriError ? 'invalid' : ''}`}
            placeholder="mongodb+srv://user:pass@cluster0.example.net/db  or  mongodb://host:27017"
            value={uriText}
            onChange={(e) => setUriText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && importUri()}
          />
          <button className="btn" onClick={importUri} disabled={!uriText.trim()}>
            Parse
          </button>
        </div>
      </div>
      {uriError && <div className="notice error" style={{ marginBottom: 12 }}>{uriError}</div>}

      <div className="side-tabs" style={{ margin: '0 -16px 16px' }}>
        {(
          [
            ['server', 'Server'],
            ['auth', 'Authentication'],
            ['tls', 'SSL / TLS'],
            ['ssh', 'SSH tunnel'],
            ['proxy', 'Proxy'],
            ['driver', 'Driver'],
            ['behavior', 'Behavior'],
            ['advanced', 'Advanced']
          ] as [TabId, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
            {id === 'ssh' && c.ssh.enabled ? ' ●' : ''}
            {id === 'proxy' && c.proxy && c.proxy.mode !== 'default' ? ' ●' : ''}
            {id === 'tls' && c.tls.enabled ? ' ●' : ''}
            {id === 'behavior' && c.readOnly ? <Icon name="lock" size={11} style={{ marginLeft: 4, color: 'var(--warn)', verticalAlign: -1 }} /> : null}
          </button>
        ))}
      </div>

      <div style={{ minHeight: 290 }}>
        {tab === 'server' && (
          <>
            <Field label="Connection type">
              <div className="segmented">
                {(
                  [
                    ['srv', 'DNS seedlist (SRV)'],
                    ['standalone', 'Standalone'],
                    ['replicaSet', 'Replica set / cluster'],
                    ['uri', 'Raw URI']
                  ] as [ConnectionConfig['mode'], string][]
                ).map(([m, label]) => (
                  <button key={m} className={c.mode === m ? 'on' : ''} onClick={() => patch({ mode: m, ...(m === 'srv' ? { tls: { ...c.tls, enabled: true } } : {}) })}>
                    {label}
                  </button>
                ))}
              </div>
            </Field>
            {c.mode === 'srv' && (
              <Field label="SRV host">
                <span className="faint mono">mongodb+srv://</span>
                <input className="input grow mono" value={c.srvHost ?? ''} placeholder="cluster0.abcde.mongodb.net" onChange={(e) => patch({ srvHost: e.target.value })} />
              </Field>
            )}
            {(c.mode === 'standalone' || c.mode === 'replicaSet') && (
              <Field label={c.mode === 'standalone' ? 'Server' : 'Members'} top>
                <div className="col grow">
                  {(c.mode === 'standalone' ? c.hosts.slice(0, 1) : c.hosts).map((h, i) => (
                    <div className="row" key={i}>
                      <input
                        className="input grow mono"
                        value={h.host}
                        placeholder="hostname"
                        onChange={(e) => patch({ hosts: c.hosts.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)) })}
                      />
                      <span className="faint">:</span>
                      <input
                        className="input mono"
                        style={{ width: 80 }}
                        value={h.port}
                        onChange={(e) => patch({ hosts: c.hosts.map((x, j) => (j === i ? { ...x, port: Number(e.target.value.replace(/\D/g, '')) || 0 } : x)) })}
                      />
                      {c.mode === 'replicaSet' && c.hosts.length > 1 && (
                        <button className="btn ghost icon" title="Remove member" onClick={() => patch({ hosts: c.hosts.filter((_, j) => j !== i) })}>
                          <Icon name="minus" />
                        </button>
                      )}
                    </div>
                  ))}
                  {c.mode === 'replicaSet' && (
                    <div>
                      <button className="link" onClick={() => patch({ hosts: [...c.hosts, { host: '', port: 27017 }] })}>
                        + Add member
                      </button>
                    </div>
                  )}
                </div>
              </Field>
            )}
            {c.mode === 'replicaSet' && (
              <Field label="Replica set name">
                <input className="input grow mono" value={c.replicaSet ?? ''} placeholder="rs0 (optional)" onChange={(e) => patch({ replicaSet: e.target.value || undefined })} />
              </Field>
            )}
            {c.mode === 'uri' && (
              <Field label="Connection string" top>
                <textarea className="input grow mono" rows={4} value={c.uri ?? ''} onChange={(e) => patch({ uri: e.target.value })} placeholder="mongodb://…" />
              </Field>
            )}
            {c.mode !== 'uri' && (
              <Field label="">
                <label className="check">
                  <input type="checkbox" checked={!!c.directConnection} onChange={(e) => patch({ directConnection: e.target.checked || undefined })} />
                  Direct connection (don&apos;t discover other replica set members)
                </label>
              </Field>
            )}
            {c.mode === 'uri' && (
              <div className="notice">
                Raw URI mode uses the connection string as is. TLS certificate files and the SSH tunnel from the other tabs still apply; the Driver tab does not.
              </div>
            )}
          </>
        )}

        {tab === 'auth' && (
          <>
            <Field label="Mechanism">
              <select className="select grow" value={c.auth.mechanism} onChange={(e) => patchAuth({ mechanism: e.target.value as AuthMechanism })}>
                {(Object.keys(AUTH_LABELS) as AuthMechanism[]).map((m) => (
                  <option key={m} value={m}>
                    {AUTH_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            {needsUser && (
              <Field label={c.auth.mechanism === 'MONGODB-AWS' ? 'Access key ID' : c.auth.mechanism === 'GSSAPI' ? 'Principal' : 'Username'}>
                <input
                  className="input grow"
                  value={c.auth.username ?? ''}
                  placeholder={c.auth.mechanism === 'MONGODB-X509' || c.auth.mechanism === 'MONGODB-AWS' ? 'optional' : ''}
                  onChange={(e) => patchAuth({ username: e.target.value || undefined })}
                />
              </Field>
            )}
            {c.auth.mechanism === 'MONGODB-AWS' && (
              <Field label="Secret access key">
                <input className="input grow" type="password" value={c.auth.password ?? ''} onChange={(e) => patchAuth({ password: e.target.value || undefined })} />
              </Field>
            )}
            {needsPassword && (
              <Field label="Password">
                {c.auth.askPassword ? (
                  <span className="faint grow">{ASKED}</span>
                ) : (
                  <input className="input grow" type="password" value={c.auth.password ?? ''} onChange={(e) => patchAuth({ password: e.target.value || undefined })} />
                )}
              </Field>
            )}
            {needsPassword && c.mode !== 'uri' && (
              <Field label="">
                <label className="check" title="The password is not stored; Shardwise asks for it on every connect, including when a session is restored">
                  <input type="checkbox" checked={!!c.auth.askPassword} onChange={(e) => patchAuth(e.target.checked ? { askPassword: true, password: undefined } : { askPassword: undefined })} />
                  Ask for the password each time I connect
                </label>
              </Field>
            )}
            {c.auth.mechanism === 'MONGODB-AWS' && (
              <Field label="Session token">
                <input className="input grow" type="password" value={c.auth.awsSessionToken ?? ''} placeholder="optional" onChange={(e) => patchAuth({ awsSessionToken: e.target.value || undefined })} />
              </Field>
            )}
            {c.auth.mechanism === 'GSSAPI' && (
              <Field label="Service name">
                <input className="input grow" value={c.auth.gssapiServiceName ?? ''} placeholder="mongodb" onChange={(e) => patchAuth({ gssapiServiceName: e.target.value || undefined })} />
              </Field>
            )}
            {needsUser && (
              <Field label="Authentication DB">
                <input
                  className="input grow"
                  value={c.auth.authSource ?? ''}
                  placeholder={['MONGODB-X509', 'GSSAPI', 'MONGODB-AWS', 'PLAIN'].includes(c.auth.mechanism) ? '$external' : 'admin'}
                  onChange={(e) => patchAuth({ authSource: e.target.value || undefined })}
                />
              </Field>
            )}
            {c.auth.mechanism === 'MONGODB-X509' && <div className="notice">X.509 uses the client certificate from the SSL / TLS tab.</div>}
            {c.auth.mechanism === 'MONGODB-AWS' && <div className="notice">Leave the keys empty to use credentials from the environment, AWS profile or instance role.</div>}
          </>
        )}

        {tab === 'tls' && (
          <>
            <Field label="">
              <label className="check">
                <input type="checkbox" checked={c.tls.enabled} onChange={(e) => patchTls({ enabled: e.target.checked })} />
                Use SSL / TLS
              </label>
            </Field>
            <fieldset disabled={!c.tls.enabled} style={{ border: 0, padding: 0, margin: 0, opacity: c.tls.enabled ? 1 : 0.5 }}>
              <Field label="CA certificate">
                <FilePicker value={c.tls.caFile} onChange={(v) => patchTls({ caFile: v || undefined })} filters={PEM} placeholder={c.tls.useSystemCA ? 'Optional extra CA file (PEM)' : 'Built-in trusted roots'} />
              </Field>
              <Field label="">
                <label className="check" title="Adds the certificates trusted by Windows, macOS or Linux (for example a company root CA) to the built-in roots and the CA file above">
                  <input type="checkbox" checked={!!c.tls.useSystemCA} onChange={(e) => patchTls({ useSystemCA: e.target.checked || undefined })} />
                  Trust the operating system&apos;s certificate store
                </label>
              </Field>
              <Field label="Client certificate + key">
                <FilePicker value={c.tls.certKeyFile} onChange={(v) => patchTls({ certKeyFile: v || undefined })} filters={PEM} placeholder="PEM file with certificate and private key" />
              </Field>
              <Field label="Key passphrase">
                <input className="input grow" type="password" value={c.tls.certKeyPassword ?? ''} onChange={(e) => patchTls({ certKeyPassword: e.target.value || undefined })} />
              </Field>
              <Field label="Server name (SNI)">
                <input
                  className="input grow mono"
                  value={c.tls.servername ?? ''}
                  placeholder="Same as the host"
                  title="Sent in the TLS handshake and checked against the server certificate; useful when the host is an IP address, a tunnel or a proxy"
                  onChange={(e) => patchTls({ servername: e.target.value || undefined })}
                />
              </Field>
              <Field label="">
                <label className="check">
                  <input type="checkbox" checked={!!c.tls.allowInvalidCertificates} onChange={(e) => patchTls({ allowInvalidCertificates: e.target.checked || undefined })} />
                  Allow invalid certificates
                </label>
              </Field>
              <Field label="">
                <label className="check">
                  <input type="checkbox" checked={!!c.tls.allowInvalidHostnames} onChange={(e) => patchTls({ allowInvalidHostnames: e.target.checked || undefined })} />
                  Allow invalid hostnames
                </label>
              </Field>
            </fieldset>
          </>
        )}

        {tab === 'ssh' && (
          <>
            <Field label="">
              <label className="check">
                <input type="checkbox" checked={c.ssh.enabled} onChange={(e) => patchSsh({ enabled: e.target.checked })} />
                Connect through an SSH tunnel
              </label>
            </Field>
            <fieldset disabled={!c.ssh.enabled} style={{ border: 0, padding: 0, margin: 0, opacity: c.ssh.enabled ? 1 : 0.5 }}>
              <Field label="SSH host">
                <input className="input grow mono" value={c.ssh.host ?? ''} onChange={(e) => patchSsh({ host: e.target.value || undefined })} />
                <span className="faint">:</span>
                <input className="input mono" style={{ width: 70 }} value={c.ssh.port ?? 22} onChange={(e) => patchSsh({ port: Number(e.target.value.replace(/\D/g, '')) || 22 })} />
              </Field>
              <Field label="SSH user">
                <input className="input grow" value={c.ssh.username ?? ''} onChange={(e) => patchSsh({ username: e.target.value || undefined })} />
              </Field>
              <Field label="Authentication">
                <div className="segmented">
                  <button className={c.ssh.method !== 'key' ? 'on' : ''} onClick={() => patchSsh({ method: 'password' })}>
                    Password
                  </button>
                  <button className={c.ssh.method === 'key' ? 'on' : ''} onClick={() => patchSsh({ method: 'key' })}>
                    Private key
                  </button>
                </div>
              </Field>
              {c.ssh.method === 'key' ? (
                <>
                  <Field label="Private key">
                    <FilePicker value={c.ssh.keyFile} onChange={(v) => patchSsh({ keyFile: v || undefined })} placeholder="~/.ssh/id_ed25519" />
                  </Field>
                  <Field label="Passphrase">
                    {c.ssh.askPassword ? (
                      <span className="faint grow">{ASKED}</span>
                    ) : (
                      <input className="input grow" type="password" value={c.ssh.passphrase ?? ''} onChange={(e) => patchSsh({ passphrase: e.target.value || undefined })} />
                    )}
                  </Field>
                </>
              ) : (
                <Field label="Password">
                  {c.ssh.askPassword ? (
                    <span className="faint grow">{ASKED}</span>
                  ) : (
                    <input className="input grow" type="password" value={c.ssh.password ?? ''} onChange={(e) => patchSsh({ password: e.target.value || undefined })} />
                  )}
                </Field>
              )}
              <Field label="">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!c.ssh.askPassword}
                    onChange={(e) => patchSsh(e.target.checked ? { askPassword: true, password: undefined, passphrase: undefined } : { askPassword: undefined })}
                  />
                  Ask for the {sshSecret === 'passphrase' ? 'key passphrase' : 'SSH password'} each time I connect
                </label>
              </Field>
            </fieldset>
          </>
        )}

        {tab === 'proxy' && <ConnectionProxyTab c={c} setC={setC} />}

        {tab === 'driver' && (
          <>
            {c.mode === 'uri' && <div className="notice" style={{ marginBottom: 12 }}>Raw URI mode: put driver options in the connection string instead.</div>}
            <fieldset disabled={c.mode === 'uri'} style={{ border: 0, padding: 0, margin: 0, opacity: c.mode === 'uri' ? 0.5 : 1 }}>
              <div className="ce-section">Server selection</div>
              <Field label="Read preference">
                <select className="select grow" value={o.readPreference ?? 'primary'} onChange={(e) => patchOpt({ readPreference: e.target.value as ConnectionConfig['options']['readPreference'] })}>
                  {['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Field label="Tag sets" top>
                <TagSets tags={o.readPreferenceTags ?? []} onChange={(t) => patchOpt({ readPreferenceTags: t })} disabled={rpPrimary} />
              </Field>
              <Field label="Timeouts (ms)">
                <span className="faint">connect</span>
                <NumberInput value={o.connectTimeoutMS || undefined} onChange={(v) => patchOpt({ connectTimeoutMS: v || undefined })} placeholder="30000" width={80} />
                <span className="faint">server selection</span>
                <NumberInput value={o.serverSelectionTimeoutMS || undefined} onChange={(v) => patchOpt({ serverSelectionTimeoutMS: v || undefined })} placeholder="15000" width={80} />
                <span className="faint">latency window</span>
                <NumberInput value={o.localThresholdMS} onChange={(v) => patchOpt({ localThresholdMS: v })} placeholder="15" width={64} />
              </Field>
              <div className="ce-section">Connection pool</div>
              <Field label="Pool size">
                <span className="faint">min</span>
                <NumberInput value={o.minPoolSize} onChange={(v) => patchOpt({ minPoolSize: v })} placeholder="0" width={70} />
                <span className="faint">max</span>
                <NumberInput value={o.maxPoolSize} onChange={(v) => patchOpt({ maxPoolSize: v })} placeholder="100" width={70} />
                <span className="faint">max idle (ms)</span>
                <NumberInput value={o.maxIdleTimeMS} onChange={(v) => patchOpt({ maxIdleTimeMS: v })} placeholder="no limit" width={84} />
              </Field>
              <Field label="Retry">
                <span className="faint">writes</span>
                <TriSelect value={o.retryWrites} onChange={(v) => patchOpt({ retryWrites: v })} />
                <span className="faint">reads</span>
                <TriSelect value={o.retryReads} onChange={(v) => patchOpt({ retryReads: v })} />
              </Field>
              <Field label="">
                <label className="check" title="For deployments reached through a load balancer (for example serverless instances)">
                  <input type="checkbox" checked={!!o.loadBalanced} onChange={(e) => patchOpt({ loadBalanced: e.target.checked || undefined })} />
                  Load-balanced deployment
                </label>
              </Field>
              <Field label="Compression">
                {COMPRESSORS.map((k) => (
                  <label key={k} className="check" title={k === 'zlib' ? 'Built into Node.js' : 'Needs an optional driver module; skipped when it is not installed'}>
                    <input
                      type="checkbox"
                      checked={!!o.compressors?.includes(k)}
                      onChange={(e) => {
                        const next = COMPRESSORS.filter((x) => (x === k ? e.target.checked : !!o.compressors?.includes(x)))
                        patchOpt({ compressors: next.length ? next : undefined })
                      }}
                    />
                    {k}
                  </label>
                ))}
                <span className="faint" style={{ fontSize: 12 }}>
                  zlib always works; zstd and snappy only with their optional modules
                </span>
              </Field>
              <div className="ce-section">Read and write concern</div>
              <Field label="Write concern">
                <span className="faint">w</span>
                <input className="input mono" style={{ width: 92 }} list="ce-w" value={o.writeConcern?.w ?? ''} placeholder="default" onChange={(e) => patchWc({ w: e.target.value.trim() || undefined })} />
                <datalist id="ce-w">
                  {['majority', '0', '1', '2', '3'].map((w) => (
                    <option key={w} value={w} />
                  ))}
                </datalist>
                <span className="faint">timeout (ms)</span>
                <NumberInput value={o.writeConcern?.wtimeoutMS} onChange={(v) => patchWc({ wtimeoutMS: v })} placeholder="none" width={80} />
                <span className="faint">journal</span>
                <TriSelect value={o.writeConcern?.journal} onChange={(v) => patchWc({ journal: v })} defaultLabel="Default" />
              </Field>
              <Field label="Read concern">
                <select className="select" value={o.readConcernLevel ?? ''} onChange={(e) => patchOpt({ readConcernLevel: (e.target.value || undefined) as ReadConcernLevel | undefined })}>
                  <option value="">Server default</option>
                  {READ_CONCERN_LEVELS.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </Field>
            </fieldset>
          </>
        )}

        {tab === 'behavior' && (
          <>
            <Field label="Safety">
              <label className="check" title="Editing, imports, drops, index and user changes, sync and paste targets, MCP and AI tools are all refused">
                <input type="checkbox" checked={!!c.readOnly} onChange={(e) => patch({ readOnly: e.target.checked || undefined })} />
                <Icon name="lock" size={12} /> Read-only connection
              </label>
            </Field>
            {c.readOnly && (
              <div className="notice" style={{ marginBottom: 12 }}>
                Every change through Shardwise is refused on this connection and its tabs open locked. The shell and playground refuse the driver&apos;s write methods; for a guarantee
                enforced by the server, also connect with a database user that only has read roles.
              </div>
            )}
            <Field label="Databases to show">
              <div className="segmented">
                <button className={c.databases?.mode !== 'manual' ? 'on' : ''} onClick={() => setDbMode('auto')}>
                  Automatic
                </button>
                <button className={c.databases?.mode === 'manual' ? 'on' : ''} onClick={() => setDbMode('manual')}>
                  Only this list
                </button>
              </div>
            </Field>
            <Field label={c.databases?.mode === 'manual' ? 'Databases' : 'Also show'} top>
              <div className="col grow" style={{ gap: 4 }}>
                <textarea className="input mono grow" rows={3} value={dbText} placeholder="One database name per line" onChange={(e) => setDbNames(e.target.value)} />
                <span className="faint" style={{ fontSize: 12 }}>
                  {c.databases?.mode === 'manual'
                    ? 'The tree lists exactly these databases (useful when listing every database is slow or not permitted).'
                    : 'The tree lists what the server reports — or, without the listDatabases privilege, the databases your roles grant access to — plus these names.'}
                </span>
              </div>
            </Field>
            <div className="ce-section">This connection only (empty = use Settings)</div>
            <Field label="Page size">
              <select className="select" value={c.overrides?.pageSize ?? ''} onChange={(e) => patchOverrides({ pageSize: Number(e.target.value) || undefined })}>
                <option value="">Use Settings ({settings.pageSize})</option>
                {/* The sizes the query tab offers. */}
                {[10, 20, 50, 100, 200, 500, 1000].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Query timeout (ms)">
              <NumberInput
                value={c.overrides?.queryTimeoutMS}
                onChange={(v) => patchOverrides({ queryTimeoutMS: v })}
                placeholder={`Preference: ${settings.queryTimeoutMS ? settings.queryTimeoutMS : 'no limit'}`}
                width={160}
              />
              <span className="faint" style={{ fontSize: 12 }}>
                0 = no limit
              </span>
            </Field>
            <Field label="Change History">
              <TriSelect value={c.overrides?.changeHistory} onChange={(v) => patchOverrides({ changeHistory: v })} defaultLabel={`Use Settings${globalHistory === null ? '' : globalHistory ? ' (on)' : ' (off)'}`} />
            </Field>
            <Field label="Default collation" top>
              <div className="col grow" style={{ gap: 8 }}>
                <select
                  className="select"
                  style={{ alignSelf: 'flex-start' }}
                  value={c.overrides?.defaultCollation === undefined ? '' : 'own'}
                  onChange={(e) => patchOverrides({ defaultCollation: e.target.value ? (settings.defaultCollation ?? null) : undefined })}
                  data-testid="conn-collation-mode"
                >
                  <option value="">Use Settings ({settings.defaultCollation ? collationLabel(settings.defaultCollation) : 'none'})</option>
                  <option value="own">This connection</option>
                </select>
                {c.overrides?.defaultCollation !== undefined && (
                  <div className="coll-inline">
                    <CollationForm value={c.overrides.defaultCollation} onChange={(v) => patchOverrides({ defaultCollation: v })} />
                  </div>
                )}
                <span className="faint" style={{ fontSize: 12 }}>
                  Collation new query tabs of this connection start with (sort order and case-insensitive matching); each tab can change it.
                </span>
              </div>
            </Field>
            <Field label="Shell startup script" top>
              <div className="col grow" style={{ gap: 4 }}>
                <textarea
                  className="input mono grow"
                  rows={3}
                  spellCheck={false}
                  value={c.shellStartupScript ?? ''}
                  placeholder="// runs in every shell of this connection, e.g. use('reports')"
                  onChange={(e) => patch({ shellStartupScript: e.target.value || undefined })}
                  data-testid="conn-shell-startup"
                />
                <span className="faint" style={{ fontSize: 12 }}>
                  Runs after the startup script of Settings → Shell & Playground when a shell session of this connection starts.
                </span>
              </div>
            </Field>
          </>
        )}

        {tab === 'advanced' && (
          <>
            <Field label="Default database">
              <input className="input grow" value={c.options.defaultDb ?? ''} onChange={(e) => patchOpt({ defaultDb: e.target.value || undefined })} />
            </Field>
            <Field label="App name">
              <input className="input grow" value={c.options.appName ?? ''} placeholder="Shardwise" onChange={(e) => patchOpt({ appName: e.target.value || undefined })} />
            </Field>
            <Field label="Extra URI options">
              <input className="input grow mono" value={c.options.extra ?? ''} placeholder="socketTimeoutMS=60000&zlibCompressionLevel=6" onChange={(e) => patchOpt({ extra: e.target.value || undefined })} />
            </Field>
            <Field label="Folder">
              <input className="input grow" value={c.folder ?? ''} placeholder="Group in connection manager" onChange={(e) => patch({ folder: e.target.value || undefined })} />
            </Field>
            <Field label="MCP">
              <label className="check" title="Lets AI agents connected to Shardwise's local MCP server (Settings → AI & automation → MCP server) query this connection">
                <input type="checkbox" checked={!!c.exposeToMcp} onChange={(e) => patch({ exposeToMcp: e.target.checked || undefined })} />
                Expose to MCP clients
              </label>
            </Field>
            <Field label="Connection string" top>
              <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                <code className="mono selectable ce-uri">{uriPreview}</code>
                <span className="faint" style={{ fontSize: 12 }}>
                  Without the password. Options in &ldquo;Extra URI options&rdquo; win over the same option set on another tab.
                  <button className="link" style={{ marginLeft: 8 }} onClick={() => void api.copyText(uriPreview)}>
                    Copy
                  </button>
                </span>
              </div>
            </Field>
          </>
        )}
      </div>

      {test && (
        <div className={`notice ${test !== 'running' && !test.ok ? 'error' : ''}`} style={{ marginTop: 12, background: test !== 'running' && test.ok ? 'var(--bg-2)' : undefined }}>
          {test === 'running' ? (
            'Testing connection…'
          ) : (
            <>
              <b>{test.ok ? 'Connection successful' : 'Connection failed'}</b>
              <ul className="steps">
                {test.steps.map((s, i) => (
                  <li key={i}>
                    <span className={s.ok ? 'ok' : 'bad'}>{s.ok ? '✓' : '✗'}</span>
                    <span>{s.name}</span>
                    {s.detail && <span className="muted selectable">— {s.detail}</span>}
                  </li>
                ))}
              </ul>
              {!test.ok && test.error && !test.steps.some((s) => !s.ok) && <div className="selectable">{test.error}</div>}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

export function editConnection(initial: ConnectionConfig): Promise<ConnectionConfig | null> {
  return openModal<ConnectionConfig | null>((close) => <Editor initial={initial} onDone={close} />)
}
