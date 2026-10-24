/**
 * "Check for updates": the newest GitHub release of the public repository (`repository` in package.json) compared
 * with the running version. Nothing is downloaded; the user gets a link to the release page.
 */

export interface UpdateInfo {
  /** 'unconfigured': package.json names no GitHub repository yet. */
  status: 'available' | 'current' | 'unconfigured' | 'error'
  current: string
  latest?: string
  /** Release page to download from. */
  url?: string
  name?: string
  publishedAt?: string
  error?: string
}

export interface GitHubRepo {
  owner: string
  repo: string
}

/** `repository` of package.json: "github:o/r", "o/r", a github.com URL, or { url }. */
export function repoFromPackage(field: unknown): GitHubRepo | null {
  const raw = typeof field === 'string' ? field : field && typeof field === 'object' ? String((field as { url?: unknown }).url ?? '') : ''
  const s = raw.trim()
  const m =
    /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s) ?? /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(s) ?? /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(s)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** Release tag → version ("v0.3.0" → "0.3.0"). */
export const tagVersion = (tag: string): string => tag.trim().replace(/^v(?=\d)/i, '')

/** Semantic version order: -1, 0, 1. A pre-release ("0.3.0-beta.1") sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre: string } => {
    const [core, pre = ''] = tagVersion(v).split('+')[0].split(/-(.*)/s)
    return { core: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const p = x.pre.split('.')
  const q = y.pre.split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    const [n, m] = [Number(p[i]), Number(q[i])]
    const d = !Number.isNaN(n) && !Number.isNaN(m) ? n - m : p[i].localeCompare(q[i])
    if (d) return Math.sign(d)
  }
  return 0
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Asks GitHub for the latest (non-draft, non-pre-release) release of `repo`. */
export async function checkLatestRelease(repo: GitHubRepo | null, current: string, fetch: FetchLike): Promise<UpdateInfo> {
  if (!repo) return { status: 'unconfigured', current }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Shardwise-update-check' }
    })
    if (res.status === 404) return { status: 'current', current }
    if (!res.ok) return { status: 'error', current, error: `GitHub answered ${res.status}${res.status === 403 ? ' (rate limit: try again later)' : ''}` }
    const r = (await res.json()) as { tag_name?: string; html_url?: string; name?: string; published_at?: string }
    if (!r.tag_name) return { status: 'error', current, error: 'GitHub returned no release version' }
    const latest = tagVersion(r.tag_name)
    return {
      status: compareVersions(latest, current) > 0 ? 'available' : 'current',
      current,
      latest,
      url: r.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/releases/latest`,
      ...(r.name ? { name: r.name } : {}),
      ...(r.published_at ? { publishedAt: r.published_at } : {})
    }
  } catch (e) {
    return { status: 'error', current, error: `Could not reach GitHub: ${(e as Error).message}` }
  }
}
