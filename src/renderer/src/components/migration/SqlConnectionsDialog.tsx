import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { dialectLabel, newSqlConnection, SQL_DIALECTS } from '@shared/migrationApi'
import type { SqlConnectionConfig, SqlDialect, SqlTestResult } from '@shared/migrationApi'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog, Modal, openModal } from '../Modal'
import { migrationApi } from './migrationClient'

const DIALECT_ICON: Record<SqlDialect, string> = { postgres: 'PG', mysql: 'My', mssql: 'MS', sqlite: 'SQ' }

export function DialectBadge({ dialect }: { dialect: SqlDialect }): ReactElement {
  return (
    <span className={`mig-dialect d-${dialect}`} title={dialectLabel(dialect)}>
      {DIALECT_ICON[dialect]}
    </span>
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): ReactElement {
  return (
    <div className="field">
      <label title={hint}>{label}</label>
      {children}
    </div>
  )
}

async function browse(save: boolean, title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (save) return api.saveFile({ title, filters })
  const r = await api.openFile({ title, filters })
  return r?.[0] ?? null
}

const SQLITE_FILTERS = [
  { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
  { name: 'All files', extensions: ['*'] }
]

function Editor({ value, onChange }: { value: SqlConnectionConfig; onChange: (c: SqlConnectionConfig) => void }): ReactElement {
  const c = value
  const patch = (p: Partial<SqlConnectionConfig>): void => onChange({ ...c, ...p })
  const setDialect = (d: SqlDialect): void => {
    const oldPort = SQL_DIALECTS.find((x) => x.id === c.dialect)!.port
    patch({ dialect: d, port: !c.port || c.port === oldPort ? SQL_DIALECTS.find((x) => x.id === d)!.port : c.port })
  }
  const ssh = c.ssh ?? { enabled: false }
  return (
    <div className="mig-conn-form">
      <Field label="Name">
        <input className="input" value={c.name} placeholder={c.dialect === 'sqlite' ? 'database file name' : 'database@host'} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <Field label="Type">
        <div className="segmented">
          {SQL_DIALECTS.map((d) => (
            <button key={d.id} className={c.dialect === d.id ? 'on' : ''} onClick={() => setDialect(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
      </Field>
      {c.dialect === 'sqlite' ? (
        <Field label="Database file" hint="Created when it does not exist">
          <div className="row">
            <input className="input grow mono" value={c.file} onChange={(e) => patch({ file: e.target.value })} placeholder="C:\data\app.db" />
            <button className="btn" onClick={async () => {
              const f = await browse(false, 'Open SQLite database', SQLITE_FILTERS)
              if (f) patch({ file: f })
            }}>
              Browse…
            </button>
            <button className="btn" title="Choose a new file to create" onClick={async () => {
              const f = await browse(true, 'New SQLite database', SQLITE_FILTERS)
              if (f) patch({ file: f })
            }}>
              New…
            </button>
          </div>
        </Field>
      ) : (
        <>
          <Field label="Host / port">
            <div className="row">
              <input className="input grow" value={c.host} onChange={(e) => patch({ host: e.target.value })} placeholder="localhost" />
              <input className="input" type="number" style={{ width: 90 }} value={c.port || ''} onChange={(e) => patch({ port: Number(e.target.value) })} />
            </div>
          </Field>
          {c.dialect === 'mssql' && (
            <Field label="Instance" hint="Named instance (resolved through SQL Server Browser; the port is ignored)">
              <input className="input" value={c.instance ?? ''} onChange={(e) => patch({ instance: e.target.value })} placeholder="optional, e.g. SQLEXPRESS" />
            </Field>
          )}
          <Field label="Database">
            <input className="input" value={c.database} onChange={(e) => patch({ database: e.target.value })} placeholder={c.dialect === 'postgres' ? 'postgres' : c.dialect === 'mssql' ? 'master' : 'optional'} />
          </Field>
          <Field label="User">
            <input className="input" value={c.user} onChange={(e) => patch({ user: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Password">
            <input className="input" type="password" value={c.password} onChange={(e) => patch({ password: e.target.value })} autoComplete="new-password" />
          </Field>

          <div className="mig-conn-section">
            <label className="check">
              <input type="checkbox" checked={c.tls.enabled} onChange={(e) => patch({ tls: { ...c.tls, enabled: e.target.checked } })} /> Use TLS / SSL
            </label>
          </div>
          {c.tls.enabled && (
            <>
              <Field label="Certificate">
                <label className="check">
                  <input type="checkbox" checked={c.tls.rejectUnauthorized} onChange={(e) => patch({ tls: { ...c.tls, rejectUnauthorized: e.target.checked } })} /> Verify the server certificate
                </label>
              </Field>
              <Field label="CA file">
                <div className="row">
                  <input className="input grow mono" value={c.tls.caFile ?? ''} onChange={(e) => patch({ tls: { ...c.tls, caFile: e.target.value } })} placeholder="optional PEM file" />
                  <button className="btn" onClick={async () => {
                    const f = await browse(false, 'CA certificate', [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }])
                    if (f) patch({ tls: { ...c.tls, caFile: f } })
                  }}>
                    Browse…
                  </button>
                </div>
              </Field>
            </>
          )}

          <div className="mig-conn-section">
            <label className="check">
              <input type="checkbox" checked={!!ssh.enabled} onChange={(e) => patch({ ssh: { port: 22, method: 'password', ...ssh, enabled: e.target.checked } })} /> Connect through an SSH tunnel
            </label>
          </div>
          {ssh.enabled && (
            <>
              <Field label="SSH host / port">
                <div className="row">
                  <input className="input grow" value={ssh.host ?? ''} onChange={(e) => patch({ ssh: { ...ssh, host: e.target.value } })} />
                  <input className="input" type="number" style={{ width: 90 }} value={ssh.port ?? 22} onChange={(e) => patch({ ssh: { ...ssh, port: Number(e.target.value) } })} />
                </div>
              </Field>
              <Field label="SSH user">
                <input className="input" value={ssh.username ?? ''} onChange={(e) => patch({ ssh: { ...ssh, username: e.target.value } })} />
              </Field>
              <Field label="Authentication">
                <div className="segmented small">
                  <button className={ssh.method !== 'key' ? 'on' : ''} onClick={() => patch({ ssh: { ...ssh, method: 'password' } })}>
                    Password
                  </button>
                  <button className={ssh.method === 'key' ? 'on' : ''} onClick={() => patch({ ssh: { ...ssh, method: 'key' } })}>
                    Private key
                  </button>
                </div>
              </Field>
              {ssh.method === 'key' ? (
                <>
                  <Field label="Key file">
                    <div className="row">
                      <input className="input grow mono" value={ssh.keyFile ?? ''} onChange={(e) => patch({ ssh: { ...ssh, keyFile: e.target.value } })} />
                      <button className="btn" onClick={async () => {
                        const f = await browse(false, 'SSH private key', [{ name: 'All files', extensions: ['*'] }])
                        if (f) patch({ ssh: { ...ssh, keyFile: f } })
                      }}>
                        Browse…
                      </button>
                    </div>
                  </Field>
                  <Field label="Passphrase">
                    <input className="input" type="password" value={ssh.passphrase ?? ''} onChange={(e) => patch({ ssh: { ...ssh, passphrase: e.target.value } })} />
                  </Field>
                </>
              ) : (
                <Field label="SSH password">
                  <input className="input" type="password" value={ssh.password ?? ''} onChange={(e) => patch({ ssh: { ...ssh, password: e.target.value } })} />
                </Field>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function ConnectionsBody({ initial, close }: { initial?: string; close: (id: string | null) => void }): ReactElement {
  const [list, setList] = useState<SqlConnectionConfig[] | null>(null)
  const [draft, setDraft] = useState<SqlConnectionConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [test, setTest] = useState<SqlTestResult | 'running' | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (select?: string): Promise<void> => {
    try {
      const l = await migrationApi.sqlListConnections()
      setList(l)
      const pick = l.find((c) => c.id === select) ?? (select === undefined ? l[0] : undefined)
      if (pick) setDraft(pick)
      else if (!l.length) setDraft({ ...newSqlConnection('postgres') })
    } catch (e) {
      toast(errorText(e), 'error')
      setList([])
    }
  }
  useEffect(() => {
    void load(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async (c: SqlConnectionConfig | null): Promise<void> => {
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: 'The connection has unsaved changes.', confirmLabel: 'Discard', danger: true }))) return
    setDraft(c ?? { ...newSqlConnection('postgres') })
    setDirty(false)
    setTest(null)
  }

  const edit = (c: SqlConnectionConfig): void => {
    setDraft(c)
    setDirty(true)
    setTest(null)
  }

  const save = async (): Promise<string | null> => {
    if (!draft) return null
    setBusy(true)
    try {
      const saved = await migrationApi.sqlSaveConnection(draft)
      setDirty(false)
      await load(saved.id)
      toast(`Saved ${saved.name}`, 'success')
      return saved.id
    } catch (e) {
      toast(errorText(e), 'error')
      return null
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft?.id) return
    if (!(await confirmDialog({ title: 'Delete connection', message: <>Delete the SQL connection <b>{draft.name}</b>?</>, confirmLabel: 'Delete', danger: true }))) return
    await migrationApi.sqlDeleteConnection(draft.id)
    setDirty(false)
    setDraft(null)
    await load()
  }

  const runTest = async (): Promise<void> => {
    if (!draft) return
    setTest('running')
    try {
      setTest(await migrationApi.sqlTestConnection(draft))
    } catch (e) {
      setTest({ ok: false, error: errorText(e), ms: 0 })
    }
  }

  return (
    <Modal
      title="SQL connections"
      icon="sql"
      width={860}
      height={620}
      onClose={() => close(null)}
      footer={
        <>
          {draft?.id && (
            <button className="btn danger" onClick={() => void remove()}>
              <Icon name="trash" size={13} /> Delete
            </button>
          )}
          <button className="btn" onClick={() => void runTest()} disabled={!draft || test === 'running'}>
            <Icon name="plug" size={13} /> Test
          </button>
          {test && (
            <span className={`mig-test ${test === 'running' ? '' : test.ok ? 'ok' : 'bad'}`} title={test !== 'running' ? (test.ok ? test.serverVersion : test.error) : undefined}>
              {test === 'running' ? (
                <>
                  <span className="mig-spinner" /> Connecting…
                </>
              ) : test.ok ? (
                <>
                  <Icon name="check" size={13} /> <span className="ellipsis">{test.serverVersion}</span> <span className="faint">{test.ms} ms</span>
                </>
              ) : (
                <>
                  <Icon name="warn" size={13} /> <span className="ellipsis selectable">{test.error}</span>
                </>
              )}
            </span>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => close(null)}>
            Close
          </button>
          <button className="btn" onClick={() => void save()} disabled={!draft || busy || (!dirty && !!draft.id)}>
            Save
          </button>
          <button
            className="btn primary"
            disabled={!draft || busy}
            onClick={async () => {
              const id = dirty || !draft?.id ? await save() : draft.id
              if (id) close(id)
            }}
          >
            <Icon name="check" size={13} /> {dirty || !draft?.id ? 'Save & use' : 'Use'}
          </button>
        </>
      }
    >
      <div className="mig-conns">
        <div className="mig-conns-list">
          <button className="btn small mig-conns-new" onClick={() => void pick(null)}>
            <Icon name="plus" size={13} /> New connection
          </button>
          <div className="list">
            {list?.map((c) => (
              <div key={c.id} className={`list-row ${draft?.id === c.id ? 'selected' : ''}`} onClick={() => void pick(c)} onDoubleClick={() => !dirty && close(c.id)}>
                <DialectBadge dialect={c.dialect} />
                <div className="grow">
                  <div className="ellipsis">{c.name}</div>
                  <div className="faint ellipsis mig-small">{c.dialect === 'sqlite' ? c.file : `${c.host}${c.port ? `:${c.port}` : ''}${c.database ? ` / ${c.database}` : ''}`}</div>
                </div>
              </div>
            ))}
            {list && !list.length && <div className="faint mig-small mig-pad">No saved connections</div>}
            {draft && !draft.id && (
              <div className="list-row selected">
                <DialectBadge dialect={draft.dialect} />
                <span className="grow ellipsis">{draft.name || 'New connection'}</span>
              </div>
            )}
          </div>
        </div>
        <div className="mig-conns-edit">
          {draft ? <Editor value={draft} onChange={edit} /> : <div className="faint">Choose a connection or create one.</div>}
        </div>
      </div>
    </Modal>
  )
}

/** Manage saved SQL connections; resolves with the connection chosen to use, or null. */
export function openSqlConnections(initial?: string): Promise<string | null> {
  return openModal<string | null>((close) => <ConnectionsBody initial={initial} close={close} />)
}
