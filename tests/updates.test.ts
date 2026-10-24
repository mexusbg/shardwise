import { describe, expect, it } from 'vitest'
import { checkLatestRelease, compareVersions, repoFromPackage, tagVersion } from '@shared/updates'

const repo = { owner: 'fidweb', repo: 'shardwise' }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('update check', () => {
  it('reads the GitHub repository from package.json', () => {
    expect(repoFromPackage('github:fidweb/shardwise')).toEqual(repo)
    expect(repoFromPackage('fidweb/shardwise')).toEqual(repo)
    expect(repoFromPackage({ type: 'git', url: 'git+https://github.com/fidweb/shardwise.git' })).toEqual(repo)
    expect(repoFromPackage('https://github.com/fidweb/shardwise')).toEqual(repo)
    expect(repoFromPackage('git@github.com:fidweb/shardwise.git')).toEqual(repo)
    expect(repoFromPackage(undefined)).toBeNull()
    expect(repoFromPackage('https://gitlab.com/x/y')).toBeNull()
  })

  it('orders versions, pre-releases before their release', () => {
    expect(compareVersions('0.2.3', '0.2.2')).toBe(1)
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0')).toBe(0)
    expect(compareVersions('0.3.0-beta.2', '0.3.0')).toBe(-1)
    expect(compareVersions('0.3.0-beta.10', '0.3.0-beta.2')).toBe(1)
    expect(compareVersions('0.2.2', '0.2.2')).toBe(0)
    expect(tagVersion('v1.2.3')).toBe('1.2.3')
  })

  it('reports a newer release with its page', async () => {
    let asked = ''
    const r = await checkLatestRelease(repo, '0.2.2', async (url) => {
      asked = url
      return json(200, { tag_name: 'v0.3.0', html_url: 'https://github.com/fidweb/shardwise/releases/tag/v0.3.0', name: 'Shardwise 0.3.0' })
    })
    expect(asked).toBe('https://api.github.com/repos/fidweb/shardwise/releases/latest')
    expect(r).toMatchObject({ status: 'available', current: '0.2.2', latest: '0.3.0', url: 'https://github.com/fidweb/shardwise/releases/tag/v0.3.0' })
  })

  it('is current with the same or an older release, or none yet', async () => {
    expect((await checkLatestRelease(repo, '0.3.0', async () => json(200, { tag_name: '0.3.0' }))).status).toBe('current')
    expect((await checkLatestRelease(repo, '0.3.0', async () => json(200, { tag_name: 'v0.2.9' }))).status).toBe('current')
    expect((await checkLatestRelease(repo, '0.3.0', async () => json(404, { message: 'Not Found' }))).status).toBe('current')
  })

  it('explains failures and the missing repository', async () => {
    expect(await checkLatestRelease(null, '0.2.2', async () => json(200, {}))).toEqual({ status: 'unconfigured', current: '0.2.2' })
    expect((await checkLatestRelease(repo, '0.2.2', async () => json(403, {}))).error).toMatch(/rate limit/)
    const offline = await checkLatestRelease(repo, '0.2.2', async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    })
    expect(offline).toMatchObject({ status: 'error', error: expect.stringContaining('Could not reach GitHub') })
  })
})
