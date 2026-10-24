import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { migrateLegacyProfile } from '../src/main/legacyProfile'
import { parseConnectionImport } from '../src/main/connectionTransfer'
import { isProfile } from '@shared/masking'

describe('rename from MongoGuru', () => {
  it('copies the old profile folder and renames the settings file', () => {
    const appData = mkdtempSync(join(tmpdir(), 'sw-appdata-'))
    const old = join(appData, 'MongoGuru')
    mkdirSync(join(old, 'Local Storage'), { recursive: true })
    mkdirSync(join(old, 'Cache'))
    writeFileSync(join(old, 'mongoguru.json'), '{"version":1,"connections":[]}')
    writeFileSync(join(old, 'history.json'), '[]')
    writeFileSync(join(old, 'Local Storage', 'x.ldb'), 'x')
    writeFileSync(join(old, 'lockfile'), '')
    const userData = join(appData, 'Shardwise')
    const file = join(userData, 'shardwise.json')

    expect(migrateLegacyProfile(appData, userData, file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('connections')
    expect(existsSync(join(userData, 'history.json'))).toBe(true)
    expect(existsSync(join(userData, 'Local Storage', 'x.ldb'))).toBe(true)
    expect(existsSync(join(userData, 'Cache'))).toBe(false)
    expect(existsSync(join(userData, 'lockfile'))).toBe(false)
    expect(existsSync(join(old, 'mongoguru.json'))).toBe(true)
    // Second start: nothing to do.
    expect(migrateLegacyProfile(appData, userData, file)).toBe(false)
  })

  it('renames the settings file in place when there is no old folder', () => {
    const appData = mkdtempSync(join(tmpdir(), 'sw-appdata-'))
    const userData = join(appData, 'custom')
    mkdirSync(userData)
    writeFileSync(join(userData, 'mongoguru.json'), '{}')
    const file = join(userData, 'shardwise.json')
    expect(migrateLegacyProfile(appData, userData, file)).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('does nothing on a fresh install', () => {
    const appData = mkdtempSync(join(tmpdir(), 'sw-appdata-'))
    expect(migrateLegacyProfile(appData, join(appData, 'Shardwise'), join(appData, 'Shardwise', 'shardwise.json'))).toBe(false)
  })

  it('still imports connection exports and masking profiles saved under the old name', () => {
    const json = JSON.stringify({ type: 'MongoGuru Connections', version: 1, exportedAt: '', connections: [{ id: 'a', name: 'Old', mode: 'uri', uri: 'mongodb://h' }] })
    const r = parseConnectionImport(json)
    expect(r.format).toBe('Shardwise')
    expect(r.connections[0].name).toBe('Old')
    expect(isProfile({ format: 'mongoguru-mask-profile', version: 1, salt: 's', rules: [] })).toBe(true)
    expect(isProfile({ format: 'other', rules: [] })).toBe(false)
  })
})
