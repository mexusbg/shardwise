// Downloads the official MongoDB Database Tools (Apache-2.0) and keeps mongodump / mongorestore plus the
// license files in resources/tools/<os>-<arch>/, which electron-builder ships as extraResources.
// Usage: node scripts/fetch-tools.mts [win-x64|mac-arm64|linux-x64 ...]   (default: the current machine)
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { downloadTools } from '../src/main/transfer/toolsDownload.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM: Record<string, string> = { win: 'win32', mac: 'darwin', linux: 'linux' }
const current = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [current]

for (const t of targets) {
  const [os, arch] = t.split('-')
  const platform = PLATFORM[os]
  if (!platform || !arch) throw new Error(`Unknown target ${t}; expected e.g. win-x64, mac-arm64, linux-x64`)
  const out = join(root, 'resources', 'tools', t)
  const exe = platform === 'win32' ? '.exe' : ''
  try {
    await readdir(out).then((f) => {
      if (f.includes(`mongodump${exe}`) && f.includes(`mongorestore${exe}`)) throw Object.assign(new Error('present'), { present: true })
    })
  } catch (e) {
    if ((e as { present?: boolean }).present) {
      console.log(`${t}: already present in ${out}`)
      continue
    }
  }
  const cache = join(root, 'resources', '.tools-cache', t)
  // Ubuntu 20.04 builds (glibc 2.31) run on current Ubuntu, Debian, Fedora and RHEL-like distros.
  const linuxOs = platform === 'linux' ? { id: 'ubuntu', idLike: [], versionId: '20.04' } : undefined
  let last = ''
  const bin = await downloadTools(
    cache,
    (p) => {
      if (p.message !== last) console.log(`${t}: ${(last = p.message)}`)
    },
    undefined,
    undefined,
    { platform, arch, os: linuxOs }
  )
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  for (const tool of ['mongodump', 'mongorestore']) await copyFile(join(bin, `${tool}${exe}`), join(out, `${tool}${exe}`))
  const pkg = dirname(bin)
  for (const f of await readdir(pkg)) {
    if (/^(LICENSE|THIRD-PARTY|README)/i.test(f)) await copyFile(join(pkg, f), join(out, f))
  }
  console.log(`${t}: bundled tools ready in ${out}`)
}
