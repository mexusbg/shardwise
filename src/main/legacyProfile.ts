import { cpSync, existsSync, readdirSync, renameSync } from 'fs'
import { basename, join } from 'path'

/** The app was called MongoGuru before; its profile folder and settings file used that name. */
const LEGACY_DIR = 'MongoGuru'
const LEGACY_FILE = 'mongoguru.json'

/** Chromium caches and lock files are not worth carrying over (and locks must never be copied). */
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'])

/**
 * One-time copy of the old MongoGuru profile into the new userData folder, then rename the settings file.
 * Runs before anything reads userData. The old folder is left in place so the move can be undone by hand.
 */
export function migrateLegacyProfile(appData: string, userData: string, file: string): boolean {
  if (existsSync(file)) return false
  const old = join(appData, LEGACY_DIR)
  if (old === userData || !existsSync(join(old, LEGACY_FILE))) {
    // No old profile to copy (or it is this folder): at most the settings file name needs changing.
    const sameDirFile = join(userData, LEGACY_FILE)
    if (existsSync(sameDirFile)) {
      renameSync(sameDirFile, file)
      return true
    }
    return false
  }
  for (const name of readdirSync(old)) {
    if (SKIP.has(name)) continue
    cpSync(join(old, name), join(userData, name), { recursive: true, force: false, errorOnExist: false, filter: (src) => !SKIP.has(basename(src)) })
  }
  const copied = join(userData, LEGACY_FILE)
  if (existsSync(copied)) renameSync(copied, file)
  return true
}
