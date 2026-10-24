import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, posix, win32 } from 'path'
import { parseUri, buildUri } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { MongoshLaunch, MongoshStatus } from '@shared/api'
import type { ConnectionManager } from './mongo/manager'
import type { PortForward, Tunnel } from './mongo/sshTunnel'
import { firstHost, viaLocalPort } from './transfer/bsonTools'

/**
 * External mongosh: finding the executable and opening it in the operating system's terminal, connected to a
 * Shardwise connection. The password never goes on the command line: mongosh gets the URI without it and asks.
 */

export interface MongoshDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
  /** Whether an executable file exists at `path`. */
  isFile: (path: string) => Promise<boolean>
  /** Runs `file args` and returns stdout (rejects on failure / timeout). */
  run: (file: string, args: string[]) => Promise<string>
}

const exe = (platform: NodeJS.Platform, name: string): string => (platform === 'win32' ? `${name}.exe` : name)
const pathApi = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/** Usual install locations of mongosh per operating system (after PATH). */
export function mongoshCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
  const p = pathApi(platform)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local')
    const pf = env.ProgramFiles ?? 'C:\\Program Files'
    return [
      p.join(local, 'Programs', 'mongosh', 'mongosh.exe'),
      p.join(pf, 'mongosh', 'mongosh.exe'),
      p.join(pf, 'MongoDB', 'mongosh', 'bin', 'mongosh.exe'),
      p.join(pf, 'mongosh', 'bin', 'mongosh.exe')
    ]
  }
  if (platform === 'darwin') return ['/opt/homebrew/bin/mongosh', '/usr/local/bin/mongosh', p.join(home, '.local', 'bin', 'mongosh'), '/usr/bin/mongosh']
  return ['/usr/bin/mongosh', '/usr/local/bin/mongosh', '/snap/bin/mongosh', p.join(home, '.local', 'bin', 'mongosh')]
}

/** First `name` found in the PATH folders (Windows: with the PATHEXT extensions). */
export async function findOnPath(name: string, d: Pick<MongoshDeps, 'platform' | 'env' | 'isFile'>): Promise<string | undefined> {
  const p = pathApi(d.platform)
  const raw = d.env.PATH ?? d.env.Path ?? ''
  const dirs = raw.split(d.platform === 'win32' ? ';' : ':').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
  const exts = d.platform === 'win32' ? (d.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : ['']
  const hasExt = d.platform === 'win32' && /\.[a-z0-9]+$/i.test(name)
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const f = p.join(dir, name + ext)
      if (await d.isFile(f)) return f
    }
  }
  return undefined
}

/** Version from `mongosh --version` output ("2.3.1"). */
export function parseMongoshVersion(out: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(out)?.[1]
}

/** Finds mongosh: the configured path (must work), else PATH, else the usual install folders; reads its version. */
export async function detectMongosh(configured: string, d: MongoshDeps = defaultDeps()): Promise<MongoshStatus> {
  const version = async (path: string): Promise<{ version?: string; error?: string }> => {
    try {
      const v = parseMongoshVersion(await d.run(path, ['--version']))
      return v ? { version: v } : { error: 'mongosh --version printed no version' }
    } catch (e) {
      return { error: `Could not run mongosh --version: ${(e as Error).message}` }
    }
  }
  const path = configured.trim()
  if (path) {
    if (!(await d.isFile(path))) return { found: false, path, source: 'settings', error: `No file at ${path}` }
    const v = await version(path)
    return { found: !v.error, path, source: 'settings', ...v }
  }
  const onPath = await findOnPath(exe(d.platform, 'mongosh'), d)
  const candidates: [string, MongoshStatus['source']][] = [
    ...(onPath ? [[onPath, 'path'] as [string, MongoshStatus['source']]] : []),
    ...mongoshCandidates(d.platform, d.env, d.home).map((c) => [c, 'common'] as [string, MongoshStatus['source']])
  ]
  for (const [c, source] of candidates) {
    if (source === 'common' && !(await d.isFile(c))) continue
    const v = await version(c)
    if (!v.error) return { found: true, path: c, source, version: v.version }
  }
  return { found: false, error: 'mongosh was not found on PATH or in the usual install folders' }
}

export function defaultDeps(): MongoshDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    isFile: async (p) => {
      try {
        return (await fs.stat(p)).isFile()
      } catch {
        return false
      }
    },
    run: (file, args) =>
      new Promise((resolve, reject) => {
        // Batch files (e.g. an npm-installed mongosh.cmd) only run through cmd.exe.
        const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
        const [f, a] = batch ? ['cmd.exe', ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`]] : [file, args]
        execFile(f, a, { timeout: 15_000, windowsHide: true, windowsVerbatimArguments: batch, env: cleanEnv(process.env) }, (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]))
          else resolve(String(stdout))
        })
      })
  }
}

/** Environment for child processes without Electron's own switches. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('ELECTRON_')) out[k] = v
  return out
}

// ---------------------------------------------------------------------------
// Connection arguments
// ---------------------------------------------------------------------------

/**
 * mongosh arguments for a connection: the URI without the password (mongosh prompts for it), opening `db`
 * when given, plus TLS file options. Secrets that mongosh would need on its command line are left out.
 */
export function mongoshArgs(cfg: ConnectionConfig, db?: string): { args: string[]; notes: string[] } {
  const notes: string[] = []
  let c = cfg
  const wantDb = db && db !== cfg.options.defaultDb
  if (wantDb || (cfg.mode === 'uri' && db)) {
    c = cfg.mode === 'uri' ? parseUri(cfg.uri ?? '', cfg) : structuredClone(cfg)
    const auth = c.auth
    // The database in the URI path is also the default authSource: keep authenticating where we did.
    if (auth.mechanism !== 'none' && auth.username && !auth.authSource) {
      const d = cfg.mode === 'uri' ? c.options.defaultDb : cfg.options.defaultDb
      auth.authSource = d || 'admin'
    }
    c.options = { ...c.options, defaultDb: db }
  }
  const args = [buildUri(c, false)]
  if (cfg.tls.enabled) {
    if (cfg.tls.caFile) args.push(`--tlsCAFile=${cfg.tls.caFile}`)
    if (cfg.tls.certKeyFile) args.push(`--tlsCertificateKeyFile=${cfg.tls.certKeyFile}`)
    if (cfg.tls.useSystemCA) args.push('--tlsUseSystemCA')
    if (cfg.tls.certKeyPassword) notes.push('The TLS key password is not passed to mongosh; it asks for it if the key needs one.')
  }
  if (cfg.auth.mechanism === 'MONGODB-AWS' && cfg.auth.awsSessionToken) notes.push('The AWS session token is not passed; mongosh reads AWS credentials from the environment.')
  if (cfg.auth.mechanism !== 'none' && cfg.auth.username && !['MONGODB-X509', 'GSSAPI', 'MONGODB-AWS'].includes(cfg.auth.mechanism)) {
    notes.push('mongosh asks for the password in the terminal; it is not passed on the command line.')
  }
  return { args, notes }
}

// ---------------------------------------------------------------------------
// Launcher script and terminal
// ---------------------------------------------------------------------------

const safeTitle = (t: string): string => t.replace(/[^\p{L}\p{N} ._()@-]/gu, '').slice(0, 60) || 'mongosh'
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
/** Double-quoted argument of a .cmd file: % must be doubled (no " can occur in paths or URIs). */
const cmdQuote = (s: string): string => `"${s.replace(/%/g, '%%').replace(/"/g, '')}"`

/**
 * Script the terminal runs: starts mongosh, keeps the window open when it fails, and deletes itself. It holds
 * the URI without the password only.
 */
export function launcherScript(platform: NodeJS.Platform, mongosh: string, args: string[], title: string): string {
  const t = safeTitle(title)
  if (platform === 'win32') {
    return [
      '@echo off',
      'chcp 65001 >nul',
      `title ${t}`,
      // `call` so a batch-file mongosh returns to this script.
      `${/\.(cmd|bat)$/i.test(mongosh) ? 'call ' : ''}${[mongosh, ...args].map(cmdQuote).join(' ')}`,
      'if errorlevel 1 pause',
      // Deletes this file without "The batch file cannot be found".
      '(goto) 2>nul & del "%~f0"',
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    'rm -f -- "$0"',
    `printf '\\033]0;%s\\007' ${shQuote(t)}`,
    [mongosh, ...args].map(shQuote).join(' '),
    'status=$?',
    'if [ "$status" -ne 0 ]; then printf "\\nmongosh exited with code %s. Press Enter to close." "$status"; read _; fi',
    ''
  ].join('\n')
}

export interface TerminalCommand {
  /** Shown to the user. */
  name: string
  file: string
  args: string[]
  verbatim?: boolean
  /** Hide the console of the launching process (cmd.exe running `start`). */
  hide?: boolean
}

/** Linux terminals tried in order, with the switch that runs a command. */
const LINUX_TERMINALS: [string, string[]][] = [
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['kitty', []],
  ['alacritty', ['-e']],
  ['xterm', ['-e']]
]

/** How to open `script` in a terminal window; `has(cmd)` tells whether a program is on PATH. */
export async function terminalCommand(platform: NodeJS.Platform, script: string, title: string, has: (cmd: string) => Promise<boolean>): Promise<TerminalCommand> {
  if (platform === 'win32') {
    if (await has('wt.exe')) {
      // Windows Terminal splits its command line at ';'.
      return { name: 'Windows Terminal', file: 'wt.exe', args: ['-w', 'new', 'new-tab', '--title', safeTitle(title), 'cmd.exe', '/d', '/c', script.replace(/;/g, '\\;')] }
    }
    return { name: 'Command Prompt', file: 'cmd.exe', args: ['/d', '/s', '/c', `"start "${safeTitle(title)}" cmd.exe /d /c "${script}""`], verbatim: true, hide: true }
  }
  if (platform === 'darwin') {
    const asStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    return {
      name: 'Terminal',
      file: 'osascript',
      args: ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${asStr(`/bin/sh ${shQuote(script)}`)}`, '-e', 'end tell']
    }
  }
  for (const [cmd, run] of LINUX_TERMINALS) {
    if (await has(cmd)) return { name: cmd, file: cmd, args: [...run, '/bin/sh', script] }
  }
  throw new Error('No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, xterm)')
}

/** Folder of launcher scripts; old leftovers (a launcher that never ran) are removed on the next launch. */
const LAUNCH_DIR = join(tmpdir(), 'shardwise-mongosh')
const STALE_MS = 24 * 3600_000

async function writeLauncher(platform: NodeJS.Platform, content: string): Promise<string> {
  await fs.mkdir(LAUNCH_DIR, { recursive: true, mode: 0o700 })
  for (const f of await fs.readdir(LAUNCH_DIR).catch(() => [] as string[])) {
    const p = join(LAUNCH_DIR, f)
    const st = await fs.stat(p).catch(() => null)
    if (st && Date.now() - st.mtimeMs > STALE_MS) await fs.rm(p, { force: true }).catch(() => {})
  }
  const file = join(LAUNCH_DIR, `mongosh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${platform === 'win32' ? 'cmd' : 'sh'}`)
  await fs.writeFile(file, content, { mode: 0o700 })
  return file
}

/** Starts the terminal and resolves once it is running (rejects when it could not be started). */
function startDetached(t: TerminalCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(t.file, t.args, { detached: true, stdio: 'ignore', windowsHide: !!t.hide, windowsVerbatimArguments: t.verbatim, env: cleanEnv(process.env) })
    child.once('error', (e) => reject(new Error(`Could not start ${t.name}: ${e.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Writes the launcher and opens it in a terminal; returns the terminal's name. */
export async function launchMongosh(mongosh: string, args: string[], title: string, d: MongoshDeps = defaultDeps()): Promise<string> {
  const script = await writeLauncher(d.platform, launcherScript(d.platform, mongosh, args, title))
  try {
    const term = await terminalCommand(d.platform, script, title, async (cmd) => !!(await findOnPath(cmd, d)))
    await startDetached(term)
    return term.name
  } catch (e) {
    await fs.rm(script, { force: true }).catch(() => {})
    throw e
  }
}

// ---------------------------------------------------------------------------
// "Open in mongosh"
// ---------------------------------------------------------------------------

/** Opens open Shardwise connections in mongosh; SSH connections get a local port forward through their tunnel. */
export class MongoshLauncher {
  private forwards = new Map<string, { tunnel: Tunnel; fwd: PortForward; target: string }>()

  constructor(
    private mgr: ConnectionManager,
    private mongoshPath: () => Promise<string>
  ) {}

  status(path: string): Promise<MongoshStatus> {
    return detectMongosh(path)
  }

  async open(connId: string, db?: string): Promise<MongoshLaunch> {
    const st = await detectMongosh(await this.mongoshPath())
    if (!st.found || !st.path) throw new Error(`${st.error ?? 'mongosh was not found'}. Install mongosh or set its path in Settings → Shell & Playground.`)
    let cfg = this.mgr.config(connId)
    const notes: string[] = []
    if (cfg.ssh.enabled) {
      const tunnel = this.mgr.tunnelFor(connId)
      if (!tunnel) throw new Error('The SSH tunnel of this connection is not open')
      let f = this.forwards.get(connId)
      if (!f || f.tunnel !== tunnel) {
        const target = await firstHost(cfg)
        f = { tunnel, fwd: await tunnel.forwardPort(target.host, target.port), target: `${target.host}:${target.port}` }
        this.forwards.set(connId, f)
        const mine = f
        tunnel.onClose(() => {
          if (this.forwards.get(connId) === mine) this.forwards.delete(connId)
        })
      }
      cfg = viaLocalPort(cfg, f.fwd.port)
      notes.push(`mongosh connects through an SSH port forward (127.0.0.1:${f.fwd.port} → ${f.target}, that host only). It stays open until you disconnect this connection in Shardwise.`)
    }
    const built = mongoshArgs(cfg, db)
    const terminal = await launchMongosh(st.path, built.args, `mongosh ${cfg.name}`)
    return { terminal, notes: [...notes, ...built.notes] }
  }

  /** Closes the port forward of a connection (on disconnect the tunnel closes it anyway). */
  release(connId: string): void {
    this.forwards.get(connId)?.fwd.close()
    this.forwards.delete(connId)
  }
}
