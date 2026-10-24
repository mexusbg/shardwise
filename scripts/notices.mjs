// Writes THIRD_PARTY_NOTICES.md: every production dependency with its license text.
// Usage: node scripts/notices.mjs   (run before packaging; dist:* scripts call it)
import { execSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString())

const seen = new Map()
const walk = (deps) => {
  for (const [name, d] of Object.entries(deps ?? {})) {
    if (!d || !d.version || !d.path) continue
    const key = `${name}@${d.version}`
    if (!seen.has(key)) seen.set(key, { name, version: d.version, path: d.path, license: d.license, repo: d.repository?.url ?? d.repository })
    walk(d.dependencies)
  }
}
walk(tree.dependencies)

const licenseText = (dir) => {
  if (!existsSync(dir)) return null
  const f = readdirSync(dir).find((x) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(x))
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
let md = `# Third-party notices\n\nShardwise includes the following open-source components. Each is used under the license shown.\n\n`
md += `MongoDB Database Tools (mongodump, mongorestore) are bundled unmodified under the Apache License 2.0; their LICENSE.md and THIRD-PARTY-NOTICES ship next to the binaries in the app's resources/tools folder.\n\n`
md += `| Package | Version | License |\n|---|---|---|\n`
for (const e of entries) md += `| ${e.name} | ${e.version} | ${typeof e.license === 'string' ? e.license : (e.license?.type ?? 'see text')} |\n`
md += '\n---\n'
for (const e of entries) {
  const text = licenseText(e.path)
  md += `\n## ${e.name} ${e.version}\n\nLicense: ${typeof e.license === 'string' ? e.license : (e.license?.type ?? 'unknown')}${e.repo ? `  \nSource: ${String(e.repo).replace(/^git\+/, '')}` : ''}\n\n`
  md += text ? '```\n' + text.replace(/```/g, "'''") + '\n```\n' : '_No license file in the package; see the license field above._\n'
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), md)
const unknown = entries.filter((e) => !e.license)
console.log(`THIRD_PARTY_NOTICES.md: ${entries.length} packages${unknown.length ? `, ${unknown.length} without a license field: ${unknown.map((e) => e.name).join(', ')}` : ''}`)
const copyleft = entries.filter((e) => /GPL|AGPL|SSPL|CC-BY-NC/i.test(typeof e.license === 'string' ? e.license : e.license?.type ?? ''))
if (copyleft.length) console.log(`Review: copyleft/restrictive licenses: ${copyleft.map((e) => `${e.name} (${e.license})`).join(', ')}`)
