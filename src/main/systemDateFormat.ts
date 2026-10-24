import { execFile } from 'child_process'
import { app } from 'electron'
import type { SystemDateFormat } from '@shared/api'

/** 'bg_BG.UTF-8' → 'bg-BG'; null for the POSIX locales that mean "not set". */
export function posixToBcp47(v: string | undefined): string | null {
  if (!v) return null
  const base = v.split('.')[0].split('@')[0]
  if (!base || base === 'C' || base === 'POSIX') return null
  return base.replace('_', '-')
}

/** Values of one registry key as name → data (REG_SZ lines of `reg query`). */
export function parseRegQuery(out: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_SZ\s+(.*)$/.exec(line)
    if (m) values[m[1]] = m[2].trim()
  }
  return values
}

function regQuery(key: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    // reg.exe writes in the console code page; switch it to UTF-8 so patterns like "d.M.yyyy 'г.'" survive.
    // Verbatim: cmd.exe does not understand Node's \" quoting; /s strips the outer quotes.
    const command = `"chcp 65001 >nul & reg query "${key}""`
    execFile('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, timeout: 3000, encoding: 'utf8', windowsVerbatimArguments: true }, (err, stdout) =>
      resolve(err ? {} : parseRegQuery(stdout))
    )
  })
}

let cached: Promise<SystemDateFormat> | null = null

/**
 * The operating system's regional date format. On Windows the short date and long time patterns the user set in
 * Region settings are read from the registry (they can differ from the locale's defaults); elsewhere the regional
 * locale is enough (LC_TIME on Linux).
 */
export function systemDateFormat(): Promise<SystemDateFormat> {
  cached ??= (async () => {
    let locale = app.getSystemLocale() || app.getLocale() || 'en-US'
    if (process.platform === 'linux') locale = posixToBcp47(process.env.LC_ALL) ?? posixToBcp47(process.env.LC_TIME) ?? posixToBcp47(process.env.LANG) ?? locale
    if (process.platform !== 'win32') return { locale }
    const intl = await regQuery('HKCU\\Control Panel\\International')
    return {
      locale: intl.LocaleName || locale,
      datePattern: intl.sShortDate || undefined,
      timePattern: intl.sLongTime || undefined
    }
  })()
  return cached
}
