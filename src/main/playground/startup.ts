import { promises as fs } from 'fs'
import { basename } from 'path'
import type { AppSettings } from '@shared/api'
import type { ConnectionConfig } from '@shared/connection'
import type { StartupScript } from './core'

export interface StartupPlan {
  scripts: StartupScript[]
  /** Scripts that could not be loaded (unreadable file), shown to the user. */
  errors: string[]
}

/** Largest startup script read from a file. */
const MAX_FILE = 2 * 1024 * 1024

/**
 * The startup scripts of a shell session (or playground run): the one from Settings (typed or read from a
 * file) first, then the connection's own. Empty scripts are skipped; an unreadable file becomes an error.
 */
export async function loadStartupScripts(
  s: Pick<AppSettings, 'shellStartupSource' | 'shellStartupScript' | 'shellStartupFile'>,
  cfg: Pick<ConnectionConfig, 'name' | 'shellStartupScript'> | undefined,
  read: (path: string) => Promise<string> = readScript
): Promise<StartupPlan> {
  const plan: StartupPlan = { scripts: [], errors: [] }
  if (s.shellStartupSource === 'file') {
    const path = s.shellStartupFile.trim()
    if (path) {
      try {
        const code = await read(path)
        if (code.trim()) plan.scripts.push({ label: basename(path), code })
      } catch (e) {
        plan.errors.push(`Could not read the startup script ${path}: ${(e as Error).message}`)
      }
    }
  } else if (s.shellStartupScript.trim()) {
    plan.scripts.push({ label: 'Settings', code: s.shellStartupScript })
  }
  const own = cfg?.shellStartupScript
  if (own?.trim()) plan.scripts.push({ label: `connection "${cfg?.name}"`, code: own })
  return plan
}

async function readScript(path: string): Promise<string> {
  const st = await fs.stat(path)
  if (!st.isFile()) throw new Error('not a file')
  if (st.size > MAX_FILE) throw new Error(`larger than ${MAX_FILE / 1024 / 1024} MB`)
  const text = await fs.readFile(path, 'utf8')
  // Drop a UTF-8 byte order mark.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
