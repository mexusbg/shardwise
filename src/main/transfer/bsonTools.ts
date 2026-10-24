import { spawn } from 'child_process'
import { createReadStream, promises as fs } from 'fs'
import { basename, delimiter as PATH_DELIMITER, dirname, join } from 'path'
import { createGunzip } from 'zlib'
import { promises as dns } from 'dns'
import { deserialize, EJSON } from 'bson'
import { buildUri, parseUri } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { Doc, ToolsStatus } from '@shared/api'
import { compareVersions, findBinDir } from './toolsDownload'

const EXE = process.platform === 'win32' ? '.exe' : ''

// ---------------------------------------------------------------------------
// Locating the tools
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Folder holding mongodump, checked as given and as `<dir>/bin`. */
async function toolsIn(dir: string): Promise<string | null> {
  if (!dir) return null
  if (await exists(join(dir, `mongodump${EXE}`))) return dir
  if (await exists(join(dir, 'bin', `mongodump${EXE}`))) return join(dir, 'bin')
  return null
}

/** Newest tools build below `<userData>/tools` (folders are named after the release archive). */
export async function downloadedToolsDir(toolsRoot: string): Promise<string | null> {
  let names: string[]
  try {
    names = (await fs.readdir(toolsRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.endsWith('.extracting')).map((d) => d.name)
  } catch {
    return null
  }
  const version = (n: string): string => /(\d+\.\d+\.\d+)/.exec(n)?.[1] ?? '0.0.0'
  names.sort((a, b) => compareVersions(version(b), version(a)))
  for (const n of names) {
    const bin = await findBinDir(join(toolsRoot, n))
    if (bin) return bin
  }
  return null
}

export interface LocatedTools {
  dir: string
  source: NonNullable<ToolsStatus['source']>
}

/** Settings folder, then the copy bundled with the app, then the auto-downloaded copy, then PATH. */
export async function locateTools(
  settingsPath: string,
  toolsRoot: string,
  envPath = process.env.PATH ?? '',
  bundledDir = ''
): Promise<LocatedTools | null> {
  const fromSettings = await toolsIn(settingsPath.trim())
  if (fromSettings) return { dir: fromSettings, source: 'settings' }
  const bundled = bundledDir ? await toolsIn(bundledDir) : null
  if (bundled) return { dir: bundled, source: 'bundled' }
  const downloaded = await downloadedToolsDir(toolsRoot)
  if (downloaded) return { dir: downloaded, source: 'downloaded' }
  for (const p of envPath.split(PATH_DELIMITER)) {
    const d = p.trim().replace(/^"|"$/g, '')
    if (d && (await exists(join(d, `mongodump${EXE}`)))) return { dir: d, source: 'path' }
  }
  return null
}

export const toolPath = (dir: string, tool: 'mongodump' | 'mongorestore'): string => join(dir, `${tool}${EXE}`)

/** `mongodump --version` → "100.9.4". */
export function parseToolVersion(out: string): string | undefined {
  return /version:\s*r?(\d+\.\d+\.\d+\S*)/i.exec(out)?.[1] ?? /(\d+\.\d+\.\d+)/.exec(out)?.[1]
}

export async function toolVersion(dir: string): Promise<string | undefined> {
  const r = await runTool(toolPath(dir, 'mongodump'), ['--version'], { timeoutMs: 15000 })
  return parseToolVersion(r.output)
}

// ---------------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------------

export interface RunOptions {
  signal?: AbortSignal
  onLine?: (line: string) => void
  timeoutMs?: number
}

export interface RunResult {
  code: number | null
  output: string
}

/** Run a tool, streaming stdout/stderr lines. Rejects when aborted; non-zero exit codes resolve. */
export function runTool(exe: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let pending = ''
    let settled = false
    const onData = (b: Buffer): void => {
      const s = b.toString('utf8')
      if (output.length < 1 << 20) output += s
      pending += s
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) o.onLine?.(l)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const kill = (): void => {
      if (!child.killed) child.kill()
    }
    const onAbort = (): void => {
      kill()
      if (!settled) {
        settled = true
        reject(o.signal?.reason instanceof Error ? o.signal.reason : new DOMException('Cancelled', 'AbortError'))
      }
    }
    if (o.signal?.aborted) return onAbort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = o.timeoutMs ? setTimeout(kill, o.timeoutMs) : undefined
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (pending.trim()) o.onLine?.(pending)
      if (settled) return
      settled = true
      resolve({ code, output })
    })
  })
}

// ---------------------------------------------------------------------------
// Connection arguments (secrets go to a temporary --config file)
// ---------------------------------------------------------------------------

export const MIN_TOOLS_VERSION = '100.3.0'

/** Database Tools older than 100.3 have no --config, so the password would have to go on the command line. */
export function assertToolsVersion(version?: string): void {
  if (version && compareVersions(version, MIN_TOOLS_VERSION) < 0) {
    throw new Error(`MongoDB Database Tools 100.3 or newer is required (found ${version}). Download them again or update the tools folder in Settings.`)
  }
}

/** YAML for the tools' --config file (supported since Database Tools 100.3). */
export function toolConfigYaml(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
    .join('')
}

/**
 * Rewrite a config so the tools connect through a local TCP port forward (SSH): a single direct
 * connection to 127.0.0.1:<port>. TLS host names cannot match 127.0.0.1, so host name checks are relaxed.
 */
export function viaLocalPort(cfg: ConnectionConfig, port: number): ConnectionConfig {
  const base = cfg.mode === 'uri' ? parseUri(cfg.uri ?? '', cfg) : structuredClone(cfg)
  base.mode = 'standalone'
  base.hosts = [{ host: '127.0.0.1', port }]
  base.replicaSet = undefined
  base.directConnection = true
  base.srvHost = undefined
  if (base.tls.enabled) base.tls = { ...base.tls, allowInvalidHostnames: true }
  return base
}

/** First real host of a connection (resolving mongodb+srv), used as the SSH forward target. */
export async function firstHost(cfg: ConnectionConfig): Promise<{ host: string; port: number }> {
  const c = cfg.mode === 'uri' ? parseUri(cfg.uri ?? '', cfg) : cfg
  if (c.mode === 'srv') {
    const recs = await dns.resolveSrv(`_mongodb._tcp.${c.srvHost}`)
    if (!recs.length) throw new Error(`No SRV records for ${c.srvHost}`)
    recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    return { host: recs[0].name, port: recs[0].port }
  }
  const h = c.hosts[0] ?? { host: 'localhost', port: 27017 }
  return { host: h.host.replace(/^\[|\]$/g, ''), port: h.port || 27017 }
}

/**
 * Build connection arguments for mongodump / mongorestore. The URI (with password) and the TLS key
 * password are written to `<dir>/tools.yaml` (mode 0600) passed with --config; the caller owns `dir`.
 */
export async function toolConnection(
  cfg: ConnectionConfig,
  opts: { dir: string; localPort?: number; toolVersion?: string }
): Promise<string[]> {
  assertToolsVersion(opts.toolVersion)
  const effective = opts.localPort ? viaLocalPort(cfg, opts.localPort) : cfg
  const file = join(opts.dir, 'tools.yaml')
  await fs.writeFile(file, toolConfigYaml({ uri: buildUri(effective, true), sslPEMKeyPassword: cfg.tls.certKeyPassword }), { mode: 0o600 })
  const args = [`--config=${file}`]
  if (cfg.tls.enabled) {
    if (cfg.tls.caFile) args.push(`--sslCAFile=${cfg.tls.caFile}`)
    if (cfg.tls.certKeyFile) args.push(`--sslPEMKeyFile=${cfg.tls.certKeyFile}`)
    // tlsAllowInvalidCertificates / tlsAllowInvalidHostnames already travel in the URI.
  }
  return args
}

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

/** Escape a literal db / collection name for --nsInclude / --nsFrom patterns. */
export function nsEscape(s: string): string {
  return s.replace(/([\\*$])/g, '\\$1')
}

export interface DumpPlan {
  db: string
  /** Collections to dump; empty or `all` = the whole database. */
  collections: string[]
  /** True when `collections` is every collection of the database. */
  all: boolean
  /** Every collection of the database (used to exclude the others). */
  existing: string[]
  query?: Doc
  archive: boolean
  gzip: boolean
  target: string
}

/**
 * mongodump arguments. One collection → --collection (+ --queryFile); a subset → --db plus one
 * --excludeCollection per collection that was not selected (mongodump has no --nsInclude), which works
 * for both folder and archive output in a single run.
 */
export function dumpArgs(p: DumpPlan, queryFile?: string): string[] {
  const args = [`--db=${p.db}`]
  if (p.collections.length === 1 && !p.all) {
    args.push(`--collection=${p.collections[0]}`)
    if (queryFile) args.push(`--queryFile=${queryFile}`)
  } else if (!p.all) {
    const keep = new Set(p.collections)
    for (const c of p.existing) if (!keep.has(c)) args.push(`--excludeCollection=${c}`)
  }
  args.push(p.archive ? `--archive=${p.target}` : `--out=${p.target}`)
  if (p.gzip) args.push('--gzip')
  return args
}

export interface RestorePlan {
  source: string
  archive: boolean
  gzip: boolean
  /** Target database; '' keeps the database names from the dump. */
  db: string
  /** Rename target when exactly one namespace is restored. */
  collection?: string
  nsInclude?: string[]
  /** Namespaces found in the dump (for the single-collection rename). */
  namespaces?: string[]
  drop: boolean
  stopOnError: boolean
}

/**
 * mongorestore arguments. A folder that directly holds .bson files is treated as a database folder:
 * we restore from its parent with --nsInclude=<folder>.* (the non-deprecated way). Target database /
 * collection renames use --nsFrom / --nsTo.
 */
export async function restoreArgs(p: RestorePlan): Promise<string[]> {
  const args: string[] = []
  let source = p.source
  let include = (p.nsInclude ?? []).filter(Boolean)
  if (!p.archive) {
    const layout = await dumpFolderLayout(p.source)
    if (layout.kind === 'db') {
      source = dirname(p.source)
      if (!include.length) include = [`${nsEscape(layout.db)}.*`]
    }
  }
  for (const ns of include) args.push(`--nsInclude=${ns}`)
  const selected = include.length ? include : (p.namespaces ?? [])
  const single = selected.length === 1 && !/[*]/.test(selected[0].replace(/\\\*/g, '')) ? selected[0] : undefined
  if (p.collection && single) {
    if (!p.db) throw new Error('A target database is required to rename a collection')
    args.push(`--nsFrom=${single}`, `--nsTo=${nsEscape(p.db)}.${nsEscape(p.collection)}`)
  } else if (p.db) {
    args.push('--nsFrom=$db$.$coll$', `--nsTo=${nsEscape(p.db)}.$coll$`)
  }
  if (p.drop) args.push('--drop')
  if (p.stopOnError) args.push('--stopOnError')
  if (p.gzip) args.push('--gzip')
  if (p.archive) args.push(`--archive=${source}`)
  else args.push(source)
  return args
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export type ToolEvent =
  | { kind: 'progress'; ns: string; done: number; total: number; percent: number; text: string }
  | { kind: 'bytes'; ns: string; percent: number; text: string }
  | { kind: 'dumped'; ns: string; count: number; text: string }
  | { kind: 'restored'; ns: string; count: number; failures: number; text: string }
  | { kind: 'summary'; restored: number; failed: number; text: string }
  | { kind: 'log'; text: string }

const stripTs = (line: string): string => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{4}|Z)?\s+/, '').trim()
const unquote = (ns: string): string => ns.replace(/^[`"']|[`"']$/g, '')

/** Classify one line of mongodump / mongorestore output. */
export function parseToolLine(line: string): ToolEvent {
  const text = stripTs(line)
  let m = /^\[[#.]*\]\s+(.+?)\s+(\d+)\/(\d+)\s+\(([\d.]+)%\)/.exec(text)
  if (m) return { kind: 'progress', ns: unquote(m[1]), done: Number(m[2]), total: Number(m[3]), percent: Number(m[4]), text }
  m = /^\[[#.]*\]\s+(.+?)\s+[\d.]+\w*\/[\d.]+\w*\s+\(([\d.]+)%\)/.exec(text)
  if (m) return { kind: 'bytes', ns: unquote(m[1]), percent: Number(m[2]), text }
  m = /^done dumping (.+) \((\d+) documents?\)$/.exec(text)
  if (m) return { kind: 'dumped', ns: unquote(m[1]), count: Number(m[2]), text }
  m = /^finished restoring (.+) \((\d+) documents?, (\d+) failures?\)$/.exec(text)
  if (m) return { kind: 'restored', ns: unquote(m[1]), count: Number(m[2]), failures: Number(m[3]), text }
  m = /^(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore/.exec(text)
  if (m) return { kind: 'summary', restored: Number(m[1]), failed: Number(m[2]), text }
  return { kind: 'log', text: text.replace(/`/g, '') }
}

// ---------------------------------------------------------------------------
// Dump inspection (namespaces)
// ---------------------------------------------------------------------------

const BSON_FILE = /^(.+?)\.(?:bson|metadata\.json)(?:\.gz)?$/

async function collectionsIn(dir: string): Promise<string[]> {
  const out = new Set<string>()
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue
    const m = BSON_FILE.exec(e.name)
    if (m && m[1] !== 'prelude') out.add(decodeDumpName(m[1]))
  }
  return [...out].sort()
}

/** mongodump percent-encodes some characters in file names (e.g. %2F for '/'). */
function decodeDumpName(n: string): string {
  try {
    // mongodump query-escapes names: space → '+', other specials → %XX.
    return decodeURIComponent(n.replace(/\+/g, ' '))
  } catch {
    return n
  }
}

export type FolderLayout = { kind: 'root'; namespaces: string[] } | { kind: 'db'; db: string; namespaces: string[] }

/** Is `dir` a dump root (db sub-folders) or a single database folder (.bson files directly inside)? */
export async function dumpFolderLayout(dir: string): Promise<FolderLayout> {
  const direct = await collectionsIn(dir)
  if (direct.length) {
    const db = basename(dir)
    return { kind: 'db', db, namespaces: direct.map((c) => `${db}.${c}`) }
  }
  const namespaces: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    for (const c of await collectionsIn(join(dir, e.name))) namespaces.push(`${e.name}.${c}`)
  }
  return { kind: 'root', namespaces: namespaces.sort() }
}

const ARCHIVE_MAGIC = 0x8199e26d

/**
 * Namespaces listed in a mongodump archive's prelude (magic number, header document, one metadata
 * document per collection, then a 0xFFFFFFFF terminator). Gzip is detected automatically.
 */
export async function archiveNamespaces(file: string): Promise<string[]> {
  const fh = await fs.open(file, 'r')
  const head = Buffer.alloc(2)
  await fh.read(head, 0, 2, 0)
  await fh.close()
  const raw = createReadStream(file)
  const stream = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(createGunzip()) : raw
  let buf = Buffer.alloc(0)
  let stage: 'magic' | 'header' | 'meta' = 'magic'
  const out: string[] = []
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (stage === 'magic') {
          if (buf.length < 4) break
          if (buf.readUInt32LE(0) !== ARCHIVE_MAGIC) throw new Error('Not a mongodump archive')
          buf = buf.subarray(4)
          stage = 'header'
          continue
        }
        if (buf.length < 4) break
        const len = buf.readInt32LE(0)
        if (len === -1) return [...new Set(out)].sort()
        if (len < 5 || len > 16 * 1024 * 1024) throw new Error('Corrupt mongodump archive prelude')
        if (buf.length < len) break
        const doc = deserialize(buf.subarray(0, len)) as Doc
        buf = buf.subarray(len)
        if (stage === 'header') stage = 'meta'
        else if (typeof doc.db === 'string' && typeof doc.collection === 'string') out.push(`${doc.db}.${doc.collection}`)
      }
      if (buf.length > 32 * 1024 * 1024) throw new Error('Corrupt mongodump archive prelude')
    }
  } finally {
    raw.destroy()
  }
  throw new Error('Unexpected end of the archive prelude')
}

/** Canonical EJSON text of a query, for --queryFile. */
export function queryFileText(filter: Doc): string {
  return EJSON.stringify(filter as never, { relaxed: false })
}
