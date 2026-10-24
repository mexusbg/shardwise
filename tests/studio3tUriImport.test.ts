import { describe, expect, it } from 'vitest'
import { parseConnectionImport } from '../src/main/connectionTransfer'
import { decodeText } from '../src/main/transfer/encoding'

// Synthetic data shaped like Studio 3T's "Export connections → URI" files. No real hosts or credentials.
const FULL = [
  '// Connections Exported from Studio 3T -- https://studio3t.com/',
  '// Exported on 22.10.2026 9:06:40',
  '',
  '// Alpha',
  'mongodb://alice:p%40ss%21@a-00.example.net:27017,a-01.example.net:27017,a-02.example.net:27017/admin?ssl=true&retryWrites=false&loadBalanced=false&replicaSet=rs-alpha&readPreference=primary&connectTimeoutMS=10000&authSource=admin&authMechanism=SCRAM-SHA-1&3t.uriVersion=3&3t.connection.name=Alpha&3t.databases=admin,alpha-prod&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true&3t.sslTlsVersion=TLS',
  '',
  '// Beta Two',
  'mongodb+srv://bob:s3cr%24t@beta.example.net/admin?appName=Beta&retryWrites=true&loadBalanced=false&replicaSet=rs-beta&readPreference=primary&srvServiceName=mongodb&connectTimeoutMS=10000&w=majority&authSource=admin&authMechanism=SCRAM-SHA-1&3t.uriVersion=3&3t.connection.name=Beta+Two&3t.databases=admin&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true&3t.sslTlsVersion=TLS',
  '',
  '// Gamma',
  'mongodb://carol:pw@10.0.0.5:27017/gamma-dev?retryWrites=true&loadBalanced=false&connectTimeoutMS=10000&authSource=gamma-dev&authMechanism=SCRAM-SHA-256&3t.uriVersion=3&3t.connection.name=Gamma&3t.databases=gamma-dev&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true',
  '',
  '// Local (1)',
  'mongodb://localhost:27017/?retryWrites=false&loadBalanced=false&serverSelectionTimeoutMS=5000&connectTimeoutMS=10000&3t.uriVersion=3&3t.connection.name=Local+%281%29&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true',
  ''
].join('\r\n')

const SECRETS = ['p@ss!', 'p%40ss%21', 's3cr$t', 's3cr%24t', ':pw@']

describe('Studio 3T URI export import', () => {
  it('reads the full format', () => {
    const r = parseConnectionImport(FULL)
    expect(r.format).toBe('Studio 3T URI export')
    expect(r.warnings).toEqual([])
    expect(r.connections.map((c) => c.name)).toEqual(['Alpha', 'Beta Two', 'Gamma', 'Local (1)'])

    const [alpha, beta, gamma, local] = r.connections
    expect(alpha).toMatchObject({
      mode: 'replicaSet',
      replicaSet: 'rs-alpha',
      hosts: [
        { host: 'a-00.example.net', port: 27017 },
        { host: 'a-01.example.net', port: 27017 },
        { host: 'a-02.example.net', port: 27017 }
      ],
      auth: { mechanism: 'SCRAM-SHA-1', username: 'alice', password: 'p@ss!', authSource: 'admin' },
      tls: { enabled: true },
      databases: { mode: 'auto', names: ['admin', 'alpha-prod'] }
    })
    // loadBalanced=false is the driver default and is not stored.
    expect(alpha.options).toMatchObject({ retryWrites: false, readPreference: 'primary', connectTimeoutMS: 10000 })
    expect(alpha.options.loadBalanced).toBeFalsy()

    expect(beta).toMatchObject({ mode: 'srv', srvHost: 'beta.example.net', auth: { username: 'bob', password: 's3cr$t' }, databases: { mode: 'auto', names: ['admin'] } })
    expect(beta.options).toMatchObject({ appName: 'Beta', retryWrites: true, writeConcern: { w: 'majority' } })

    expect(gamma).toMatchObject({ mode: 'standalone', auth: { mechanism: 'SCRAM-SHA-256', authSource: 'gamma-dev' }, tls: { enabled: false }, databases: { mode: 'auto', names: ['gamma-dev'] } })
    expect(gamma.options.defaultDb).toBe('gamma-dev')

    expect(local).toMatchObject({ mode: 'standalone', auth: { mechanism: 'none' } })
    expect(local.options.serverSelectionTimeoutMS).toBe(5000)

    // No Studio 3T option reaches the driver, and the default srvServiceName is dropped.
    for (const c of r.connections) expect(c.options.extra ?? '').not.toMatch(/3t\.|srvServiceName/i)
  })

  it('reads a file whose header comment is in the Windows ANSI code page (cp1251)', () => {
    const header = Buffer.from([0x2f, 0x2f, 0x20, 0x45, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x65, 0x64, 0x20, 0x6f, 0x6e, 0x20, 0x32, 0x32, 0x2e, 0x31, 0x30, 0x2e, 0x32, 0x30, 0x32, 0x36, 0x20, 0xe3, 0x2e]) // "// Exported on 22.10.2026 г."
    const body = Buffer.from('\r\n\r\n// Alpha\r\n' + FULL.split('\r\n')[4] + '\r\n', 'utf8')
    const { text } = decodeText(Buffer.concat([header, body]), true, 'bg-BG')
    const r = parseConnectionImport(text)
    expect(r.connections.map((c) => c.name)).toEqual(['Alpha'])
  })

  it('takes names from the comment when the name option is missing, and handles a missing header', () => {
    const text = ['// Прод сървър', 'mongodb://h1.example.net:27017/?3t.uriVersion=3', '', '# Second', 'mongodb://h2.example.net:27017/', 'mongodb://h3.example.net:27017/'].join('\n')
    const r = parseConnectionImport(text)
    expect(r.connections.map((c) => c.name)).toEqual(['Прод сървър', 'Second', 'h3.example.net'])
  })

  it('decodes percent-encoded names, including Cyrillic', () => {
    const r = parseConnectionImport('mongodb://h.example.net/?3t.connection.name=%D0%9F%D1%80%D0%BE%D0%B4+%E2%80%94+main')
    expect(r.connections[0].name).toBe('Прод — main')
  })

  it('exports made without passwords ask for the password at connect time', () => {
    const text = ['// Connections Exported from Studio 3T', '// NoPw', 'mongodb://dave@db.example.net:27017/admin?authSource=admin&authMechanism=SCRAM-SHA-256&3t.connection.name=NoPw'].join('\n')
    const r = parseConnectionImport(text)
    expect(r.connections[0].auth).toMatchObject({ username: 'dave', askPassword: true })
    expect(r.connections[0].auth.password).toBeUndefined()
    expect(r.warnings.join(' ')).toMatch(/1 connection has no saved password.*NoPw/)
  })

  it('plain URI lists without any Studio 3T parts still work', () => {
    const r = parseConnectionImport('mongodb://eve:pw@x.example.net:27017/app\nmongodb+srv://y.example.net/')
    expect(r.format).toBe('URI list')
    expect(r.connections).toHaveLength(2)
    expect(r.warnings).toEqual([])
  })

  it('lists unknown Studio 3T settings by name only and never echoes connection strings', () => {
    const text = [
      '// Odd',
      'mongodb://alice:p%40ss%21@x.example.net:27017/?3t.connection.name=Odd&3t.someFutureOption=secret-value&3t.uriVersion=4',
      'mongodb://alice:p%40ss%21@x.example.net:notaport/?authMechanism=SCRAM-SHA-1'
    ].join('\n')
    const r = parseConnectionImport(text)
    const all = r.warnings.join('\n')
    expect(all).toMatch(/Studio 3T settings not imported: 3t\.someFutureOption/)
    expect(all).toMatch(/newer Studio 3T \(URI format 4\)/)
    expect(all).not.toMatch(/secret-value/)
    for (const s of SECRETS) expect(all).not.toContain(s)
  })

  it('shows only the listed databases when role databases are switched off', () => {
    const r = parseConnectionImport('mongodb://u:p@x.example.net/?authSource=admin&3t.databases=app&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=false')
    expect(r.connections[0].databases).toEqual({ mode: 'manual', names: ['app', 'admin'] })
  })

  it('reads SSH tunnels (password and private key), colour, direct mode and self-signed certificates', () => {
    const text = [
      '// Tunnel pw',
      'mongodb://u:p@10.1.0.4:27017/admin?ssl=true&3t.uriVersion=3&3t.connection.name=Tunnel+pw&3t.ssh=true&3t.sshAddress=bastion.example.net&3t.sshPort=2222&3t.sshUser=jump&3t.sshAuthMode=password&3t.sshPassword=tunnel%21pw&3t.sslSelfSignedCerts=true&3t.defaultColor=107,169,112&3t.proxyType=none',
      '// Tunnel key',
      'mongodb://u:p@10.1.0.5:27017/?3t.connection.name=Tunnel+key&3t.ssh=true&3t.sshAddress=bastion.example.net&3t.sshUser=jump&3t.sshAuthMode=privateKey&3t.sshPKPath=C%3A%5Ckeys%5Cid_ed25519&3t.connectionMode=direct'
    ].join('\n')
    const r = parseConnectionImport(text)
    expect(r.warnings).toEqual([])
    const [pw, key] = r.connections
    expect(pw.ssh).toMatchObject({ enabled: true, host: 'bastion.example.net', port: 2222, username: 'jump', method: 'password', password: 'tunnel!pw' })
    expect(pw.tls).toMatchObject({ enabled: true, allowInvalidCertificates: true })
    expect(pw.color).toBe('#6ba970')
    expect(key.ssh).toMatchObject({ enabled: true, port: 22, method: 'key', keyFile: 'C:\\keys\\id_ed25519' })
    expect(key.ssh.password).toBeUndefined()
    expect(key.directConnection).toBe(true)
  })

  it('reads format 2 timeouts and legacy TLS options', () => {
    const r = parseConnectionImport(
      'mongodb://h1.example.net:27017,h2.example.net:27017/?sslInvalidHostNameAllowed=true&3t.uriVersion=2&3t.connectionMode=multi&3t.sharded=true&3t.connectTimeout=15000&3t.socketTimeout=60000&3t.connection.name=Old'
    )
    expect(r.warnings).toEqual([])
    const c = r.connections[0]
    expect(c.options.connectTimeoutMS).toBe(15000)
    expect(c.options.extra).toBe('socketTimeoutMS=60000')
    expect(c.tls.allowInvalidHostnames).toBe(true)
    expect(c.directConnection).toBeFalsy()
  })

  it('preview warnings of the full file contain no secrets', () => {
    const r = parseConnectionImport(FULL)
    const text = JSON.stringify(r.warnings) + r.format
    for (const s of SECRETS) expect(text).not.toContain(s)
  })
})
