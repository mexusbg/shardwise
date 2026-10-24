import { describe, expect, it } from 'vitest'
import { newConnectionConfig, parseUri } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { detectMongosh, findOnPath, launcherScript, mongoshArgs, mongoshCandidates, parseMongoshVersion, terminalCommand } from '../src/main/mongosh'
import type { MongoshDeps } from '../src/main/mongosh'

/** Fake file system and process runner. */
function deps(o: { platform: NodeJS.Platform; files: string[]; env?: Record<string, string>; versions?: Record<string, string> }): MongoshDeps & { ran: string[] } {
  const ran: string[] = []
  return {
    platform: o.platform,
    env: o.env ?? {},
    home: o.platform === 'win32' ? 'C:\\Users\\me' : '/home/me',
    isFile: async (p) => o.files.includes(p),
    run: async (file, args) => {
      ran.push(`${file} ${args.join(' ')}`)
      const v = o.versions?.[file]
      if (v === undefined) throw new Error('spawn failed')
      return v
    },
    ran
  }
}

describe('mongosh detection', () => {
  it('lists the usual install folders per OS', () => {
    expect(mongoshCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'C:\\Users\\me')).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Programs\\mongosh\\mongosh.exe',
      'C:\\Program Files\\mongosh\\mongosh.exe',
      'C:\\Program Files\\MongoDB\\mongosh\\bin\\mongosh.exe',
      'C:\\Program Files\\mongosh\\bin\\mongosh.exe'
    ])
    expect(mongoshCandidates('darwin', {}, '/Users/me')).toContain('/opt/homebrew/bin/mongosh')
    expect(mongoshCandidates('linux', {}, '/home/me')).toEqual(['/usr/bin/mongosh', '/usr/local/bin/mongosh', '/snap/bin/mongosh', '/home/me/.local/bin/mongosh'])
  })

  it('searches PATH (with PATHEXT on Windows)', async () => {
    const win = deps({ platform: 'win32', files: ['D:\\bin\\wt.EXE'.replace('.EXE', '.exe')], env: { Path: 'C:\\x;"D:\\bin"', PATHEXT: '.COM;.EXE' } })
    expect(await findOnPath('wt', win)).toBe('D:\\bin\\wt.exe')
    expect(await findOnPath('wt.exe', win)).toBe('D:\\bin\\wt.exe')
    expect(await findOnPath('nope', win)).toBeUndefined()
    const lin = deps({ platform: 'linux', files: ['/usr/local/bin/mongosh'], env: { PATH: '/usr/bin:/usr/local/bin' } })
    expect(await findOnPath('mongosh', lin)).toBe('/usr/local/bin/mongosh')
  })

  it('reads the version', () => {
    expect(parseMongoshVersion('2.3.1\n')).toBe('2.3.1')
    expect(parseMongoshVersion('mongosh 2.5.0-rc.1')).toBe('2.5.0-rc.1')
    expect(parseMongoshVersion('nothing')).toBeUndefined()
  })

  it('prefers the configured path and reports why it does not work', async () => {
    const d = deps({ platform: 'linux', files: ['/opt/mongosh/bin/mongosh', '/usr/bin/mongosh'], versions: { '/opt/mongosh/bin/mongosh': '2.2.0\n', '/usr/bin/mongosh': '2.3.1' } })
    expect(await detectMongosh('/opt/mongosh/bin/mongosh', d)).toEqual({ found: true, path: '/opt/mongosh/bin/mongosh', source: 'settings', version: '2.2.0' })
    expect(await detectMongosh('/missing/mongosh', d)).toMatchObject({ found: false, source: 'settings', error: 'No file at /missing/mongosh' })
    const broken = deps({ platform: 'linux', files: ['/opt/m'], versions: {} })
    expect(await detectMongosh('/opt/m', broken)).toMatchObject({ found: false, error: expect.stringMatching(/Could not run mongosh --version/) })
  })

  it('finds mongosh on PATH first, then in install folders', async () => {
    const onPath = deps({ platform: 'linux', files: ['/home/me/bin/mongosh', '/usr/bin/mongosh'], env: { PATH: '/home/me/bin' }, versions: { '/home/me/bin/mongosh': '2.3.1', '/usr/bin/mongosh': '1.0.0' } })
    expect(await detectMongosh('', onPath)).toEqual({ found: true, path: '/home/me/bin/mongosh', source: 'path', version: '2.3.1' })
    const common = deps({
      platform: 'win32',
      files: ['C:\\Program Files\\mongosh\\mongosh.exe'],
      env: { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      versions: { 'C:\\Program Files\\mongosh\\mongosh.exe': '2.3.1' }
    })
    expect(await detectMongosh('', common)).toMatchObject({ found: true, path: 'C:\\Program Files\\mongosh\\mongosh.exe', source: 'common' })
    expect(common.ran).toEqual(['C:\\Program Files\\mongosh\\mongosh.exe --version'])
    const none = deps({ platform: 'darwin', files: [], env: { PATH: '/usr/bin' } })
    expect(await detectMongosh('', none)).toMatchObject({ found: false, error: expect.stringMatching(/not found/) })
  })
})

describe('mongosh connection arguments', () => {
  const cfg = (patch: Partial<ConnectionConfig>): ConnectionConfig => ({ ...newConnectionConfig(), name: 'Prod', ...patch })

  it('never puts the password on the command line', () => {
    const c = cfg({ mode: 'standalone', hosts: [{ host: 'db.example.com', port: 27017 }], auth: { mechanism: 'DEFAULT', username: 'app', password: 's3cr%t', authSource: 'admin' } })
    const { args, notes } = mongoshArgs(c)
    expect(args.join(' ')).not.toContain('s3cr')
    expect(args[0]).toMatch(/^mongodb:\/\/app@db\.example\.com:27017\//)
    expect(notes.join(' ')).toMatch(/asks for the password/)
    const uri = cfg({ mode: 'uri', uri: 'mongodb://app:hunter2@h1:27017/?authSource=admin' })
    expect(mongoshArgs(uri).args.join(' ')).not.toContain('hunter2')
  })

  it('opens the database and keeps authenticating against the original source', () => {
    const c = cfg({ mode: 'standalone', hosts: [{ host: 'h', port: 27017 }], auth: { mechanism: 'DEFAULT', username: 'app', password: 'x' } })
    const [uri] = mongoshArgs(c, 'shop').args
    expect(uri).toMatch(/^mongodb:\/\/app@h:27017\/shop\?/)
    expect(new URL(uri).searchParams.get('authSource')).toBe('admin')
    const fromUri = cfg({ mode: 'uri', uri: 'mongodb://app:x@h:27017/reports' })
    const [u2] = mongoshArgs(fromUri, 'shop').args
    expect(u2).toMatch(/\/shop\?/)
    expect(new URL(u2).searchParams.get('authSource')).toBe('reports')
    expect(u2).not.toContain(':x@')
  })

  it('passes TLS files as options', () => {
    const c = cfg({ ...parseUri('mongodb://h:27017'), tls: { enabled: true, caFile: '/ca.pem', certKeyFile: '/me.pem', certKeyPassword: 'pw', useSystemCA: true } })
    const { args, notes } = mongoshArgs(c)
    expect(args.slice(1)).toEqual(['--tlsCAFile=/ca.pem', '--tlsCertificateKeyFile=/me.pem', '--tlsUseSystemCA'])
    expect(args.join(' ')).not.toContain('pw')
    expect(notes.join(' ')).toMatch(/TLS key password is not passed/)
  })
})

describe('mongosh launcher', () => {
  it('writes a cmd launcher with quoting and self-deletion', () => {
    const s = launcherScript('win32', 'C:\\Program Files\\mongosh\\mongosh.exe', ['mongodb://u%40x@h:1/?a=b&c=d'], 'mongosh Prod & Co')
    const lines = s.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    expect(lines).toContain('title mongosh Prod  Co')
    expect(lines).toContain('"C:\\Program Files\\mongosh\\mongosh.exe" "mongodb://u%%40x@h:1/?a=b&c=d"')
    expect(lines).toContain('(goto) 2>nul & del "%~f0"')
    expect(launcherScript('win32', 'C:\\npm\\mongosh.cmd', [], 't')).toContain('call "C:\\npm\\mongosh.cmd"')
  })

  it('writes a sh launcher with single quotes', () => {
    const s = launcherScript('linux', '/usr/bin/mongosh', ["mongodb://h/?appName=it's"], 'Prod')
    expect(s.startsWith('#!/bin/sh\nrm -f -- "$0"\n')).toBe(true)
    expect(s).toContain(`'/usr/bin/mongosh' 'mongodb://h/?appName=it'\\''s'`)
  })

  it('picks a terminal per OS', async () => {
    const has = (list: string[]) => async (c: string): Promise<boolean> => list.includes(c)
    const wt = await terminalCommand('win32', 'C:\\t\\a;b.cmd', 'x', has(['wt.exe']))
    expect(wt).toMatchObject({ name: 'Windows Terminal', file: 'wt.exe' })
    expect(wt.args.slice(-4)).toEqual(['cmd.exe', '/d', '/c', 'C:\\t\\a\\;b.cmd'])
    const cmd = await terminalCommand('win32', 'C:\\t\\a.cmd', 'x', has([]))
    expect(cmd).toMatchObject({ name: 'Command Prompt', file: 'cmd.exe', verbatim: true })
    expect(cmd.args[3]).toBe('"start "x" cmd.exe /d /c "C:\\t\\a.cmd""')
    const mac = await terminalCommand('darwin', '/tmp/it\'s.sh', 'x', has([]))
    expect(mac.file).toBe('osascript')
    expect(mac.args).toContain(`do script "/bin/sh '/tmp/it'\\\\''s.sh'"`)
    expect(await terminalCommand('linux', '/tmp/a.sh', 'x', has(['konsole', 'xterm']))).toMatchObject({ file: 'konsole', args: ['-e', '/bin/sh', '/tmp/a.sh'] })
    expect(await terminalCommand('linux', '/tmp/a.sh', 'x', has(['gnome-terminal']))).toMatchObject({ args: ['--', '/bin/sh', '/tmp/a.sh'] })
    await expect(terminalCommand('linux', '/tmp/a.sh', 'x', has([]))).rejects.toThrow(/No terminal emulator/)
  })
})
