import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import extractZip from 'extract-zip'
import * as tar from 'tar'

/** Shape of https://downloads.mongodb.org/tools/db/full.json (only the parts we use). */
export interface ToolsFeed {
  versions: {
    version: string
    downloads: { name: string; arch: string; archive?: { url: string; sha256?: string } }[]
  }[]
}

export interface ToolsDownload {
  version: string
  /** Platform key in the feed, e.g. `windows`, `macos`, `ubuntu2204`. */
  name: string
  arch: string
  url: string
  sha256?: string
}

export const TOOLS_FEED_URL = 'https://downloads.mongodb.org/tools/db/full.json'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>
let httpFetch: FetchFn = (input, init) => fetch(input, init)

/**
 * The app routes downloads through its proxy-aware fetch (src/main/net/fetch.ts). Kept injectable so
 * scripts/fetch-tools.mts can run this module with plain Node.
 */
export function setToolsFetch(f: FetchFn): void {
  httpFetch = f
}

/** Linux distro info, the relevant bits of /etc/os-release. */
export interface OsRelease {
  id?: string
  idLike?: string[]
  versionId?: string
}

export function parseOsRelease(text: string): OsRelease {
  const kv: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return {
    id: kv.ID?.toLowerCase(),
    idLike: kv.ID_LIKE ? kv.ID_LIKE.toLowerCase().split(/\s+/) : [],
    versionId: kv.VERSION_ID
  }
}

/** Feed arch names for a Node `process.arch`. */
export function feedArches(arch: string): string[] {
  if (arch === 'x64') return ['x86_64']
  if (arch === 'arm64') return ['arm64', 'aarch64']
  if (arch === 'ppc64') return ['ppc64le']
  if (arch === 's390x') return ['s390x']
  return [arch]
}

/**
 * Feed platform names to try, best first. On Linux the distro build matching /etc/os-release is preferred
 * (ubuntu2404, debian12, rhel93, amazon2023, …); otherwise we fall back to Ubuntu 22.04, then any build for
 * the architecture. The tools are Go binaries with few system dependencies, so the Ubuntu build runs on most
 * glibc distros.
 */
export function platformCandidates(platform: string, os?: OsRelease): string[] {
  if (platform === 'win32') return ['windows']
  if (platform === 'darwin') return ['macos']
  if (platform !== 'linux') return []
  const out: string[] = []
  const id = os?.id ?? ''
  const like = os?.idLike ?? []
  const ver = os?.versionId ?? ''
  const [major = '', minor = ''] = ver.split('.')
  const isFamily = (f: string): boolean => id === f || like.includes(f)
  if (id === 'ubuntu' || (like.includes('ubuntu') && id !== 'debian')) {
    if (id === 'ubuntu' && major) out.push(`ubuntu${major}${minor.padStart(2, '0')}`)
    out.push('ubuntu2404', 'ubuntu2204', 'ubuntu2004')
  } else if (id === 'debian') {
    if (major) out.push(`debian${major}`)
    if (major === '9') out.push('debian92')
    out.push('debian12', 'debian11')
  } else if (id === 'amzn') {
    if (major) out.push(`amazon${major}`)
    out.push('amazon2023', 'amazon2')
  } else if (isFamily('rhel') || isFamily('fedora') || isFamily('centos')) {
    if (major) {
      // rhel feed names are rhel<major><minor> (rhel88, rhel93) or rhel<major> / rhel<major>0.
      out.push(`rhel${major}${minor}`, `rhel${major}0`, `rhel${major}`)
      if (major === '9') out.push('rhel93', 'rhel90')
      if (major === '8') out.push('rhel88', 'rhel80')
    }
    out.push('rhel93', 'rhel88')
  } else if (isFamily('suse') || isFamily('sles') || id.startsWith('opensuse')) {
    if (major) out.push(`suse${major}`)
    out.push('suse15')
  }
  out.push('ubuntu2204', 'ubuntu2004', 'debian12', 'rhel93', 'rhel88')
  return [...new Set(out)]
}

/** Compare dotted versions; prerelease tags (`-alpha1`) sort before the release. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')
  const pb = b.split('-')
  const na = pa[0].split('.').map(Number)
  const nb = pb[0].split('.').map(Number)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0)
    if (d) return d
  }
  if (pa.length !== pb.length) return pa.length > pb.length ? -1 : 1
  return (pa[1] ?? '').localeCompare(pb[1] ?? '')
}

/** Pick the newest stable tools build for the given platform / arch. Returns null when none matches. */
export function pickToolsDownload(feed: ToolsFeed, platform: string, arch: string, os?: OsRelease): ToolsDownload | null {
  const names = platformCandidates(platform, os)
  const arches = feedArches(arch)
  const versions = feed.versions
    .filter((v) => /^\d+(\.\d+)*$/.test(v.version))
    .sort((a, b) => compareVersions(b.version, a.version))
  for (const v of versions) {
    for (const name of names) {
      const d = v.downloads.find((x) => x.name === name && arches.includes(x.arch) && x.archive?.url)
      if (d && d.archive) return { version: v.version, name: d.name, arch: d.arch, url: d.archive.url, sha256: d.archive.sha256 }
    }
  }
  return null
}

async function readOsRelease(): Promise<OsRelease | undefined> {
  try {
    return parseOsRelease(await fs.readFile('/etc/os-release', 'utf8'))
  } catch {
    return undefined
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(path), h)
  return h.digest('hex')
}

/** Find a `bin` folder containing mongodump below `root` (archives contain `<name>/bin/…`). */
export async function findBinDir(root: string, depth = 3, platform: string = process.platform): Promise<string | null> {
  const exe = platform === 'win32' ? 'mongodump.exe' : 'mongodump'
  try {
    await fs.access(join(root, exe))
    return root
  } catch {
    /* keep looking */
  }
  if (depth === 0) return null
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findBinDir(join(root, e.name), depth - 1, platform)
    if (found) return found
  }
  return null
}

export interface DownloadProgress {
  received: number
  total?: number
  message: string
}

/**
 * Download the official MongoDB Database Tools into `<toolsRoot>/<archive name>/` and return the bin folder.
 * Verifies the sha256 from the feed when present.
 */
export async function downloadTools(
  toolsRoot: string,
  onProgress: (p: DownloadProgress) => void = () => {},
  signal?: AbortSignal,
  feedUrl = TOOLS_FEED_URL,
  /** Build for another platform (packaging); defaults to the running one. */
  target?: { platform: string; arch: string; os?: OsRelease }
): Promise<string> {
  onProgress({ received: 0, message: 'Fetching the MongoDB Database Tools release list…' })
  const feedRes = await httpFetch(feedUrl, { signal })
  if (!feedRes.ok) throw new Error(`Could not fetch ${feedUrl}: HTTP ${feedRes.status}`)
  const feed = (await feedRes.json()) as ToolsFeed
  const platform = target?.platform ?? process.platform
  const arch = target?.arch ?? process.arch
  const os = target ? target.os : process.platform === 'linux' ? await readOsRelease() : undefined
  const pick = pickToolsDownload(feed, platform, arch, os)
  if (!pick) throw new Error(`No MongoDB Database Tools build is available for ${platform}/${arch}`)

  const fileName = pick.url.split('/').pop() ?? `mongodb-database-tools-${pick.version}`
  const baseName = fileName.replace(/\.(zip|tgz|tar\.gz)$/, '')
  const dest = join(toolsRoot, baseName)
  const existing = await findBinDir(dest, 3, platform)
  if (existing) return existing

  await fs.mkdir(toolsRoot, { recursive: true })
  const tmpFile = join(toolsRoot, `${fileName}.download`)
  const res = await httpFetch(pick.url, { signal })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${pick.url}`)
  const total = Number(res.headers.get('content-length')) || undefined
  let received = 0
  let last = 0
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
  body.on('data', (c: Buffer) => {
    received += c.length
    const now = Date.now()
    if (now - last > 100) {
      last = now
      onProgress({ received, total, message: `Downloading MongoDB Database Tools ${pick.version} (${pick.name} ${pick.arch})…` })
    }
  })
  try {
    await pipeline(body, createWriteStream(tmpFile), { signal })
    if (pick.sha256) {
      onProgress({ received, total, message: 'Verifying checksum…' })
      const actual = await sha256File(tmpFile)
      if (actual.toLowerCase() !== pick.sha256.toLowerCase()) throw new Error('Checksum mismatch for the downloaded tools archive')
    }
    onProgress({ received, total, message: 'Extracting…' })
    const staging = `${dest}.extracting`
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(staging, { recursive: true })
    if (fileName.endsWith('.zip')) await extractZip(tmpFile, { dir: staging })
    else await tar.x({ file: tmpFile, cwd: staging })
    await fs.rm(dest, { recursive: true, force: true })
    // Archives contain a single top folder named like the archive; hoist it to keep paths short
    // (Windows cannot start executables whose path exceeds MAX_PATH).
    const top = await fs.readdir(staging, { withFileTypes: true })
    if (top.length === 1 && top[0].isDirectory()) {
      await fs.rename(join(staging, top[0].name), dest)
      await fs.rm(staging, { recursive: true, force: true })
    } else {
      await fs.rename(staging, dest)
    }
  } finally {
    await fs.rm(tmpFile, { force: true })
  }
  const bin = await findBinDir(dest, 3, platform)
  if (!bin) throw new Error('The downloaded archive does not contain mongodump')
  if (platform !== 'win32' && process.platform !== 'win32') {
    for (const f of await fs.readdir(bin)) await fs.chmod(join(bin, f), 0o755).catch(() => {})
  }
  return bin
}
