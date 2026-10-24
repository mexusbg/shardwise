import { app, session } from 'electron'
import { chromiumProxyConfig, normalizeProxySettings } from '@shared/proxy'
import type { ProxySettings } from '@shared/proxy'
import type { ProxyApi } from '@shared/proxyApi'
import { proxyRouter } from './proxy'

/**
 * Electron side of the proxy settings: Chromium's own requests (session) follow Settings → Network & tools, a
 * proxy asking for credentials gets the saved ones, and "system" mode resolves through Chromium.
 */

export interface ProxySource {
  getSettings(): Promise<{ proxy: ProxySettings }>
  proxyPassword(): Promise<string | undefined>
}

let lastApplied = ''

/** Point the default session at the configured proxy (Chromium-made requests, `net.fetch`). */
export async function applySessionProxy(s: ProxySettings): Promise<void> {
  const cfg = chromiumProxyConfig(s)
  const key = JSON.stringify(cfg)
  if (key === lastApplied) return
  lastApplied = key
  await session.defaultSession.setProxy(cfg)
  // Drop pooled connections made with the old settings.
  await session.defaultSession.closeAllConnections().catch(() => {})
}

/** Wire the router, the session and proxy authentication. Call once the app is ready. */
export function installProxySupport(src: ProxySource): void {
  proxyRouter.configure({
    settings: async () => (await src.getSettings()).proxy,
    password: () => src.proxyPassword(),
    resolveSystem: (url) => session.defaultSession.resolveProxy(url)
  })
  void src.getSettings().then(
    (s) => applySessionProxy(s.proxy),
    (e) => console.error('Could not apply the proxy settings:', e)
  )

  // Chromium asks once per challenge; a second challenge for the same proxy shortly after means the saved
  // credentials were rejected, so give up instead of looping.
  const recent = new Map<string, number>()
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return
    event.preventDefault()
    const key = `${authInfo.host}:${authInfo.port}`
    const now = Date.now()
    const prev = recent.get(key)
    recent.set(key, now)
    if (prev && now - prev < 10000) return callback()
    void (async () => {
      const s = (await src.getSettings()).proxy
      if (!s.username) return callback()
      callback(s.username, (await src.proxyPassword()) ?? '')
    })().catch(() => callback())
  })
}

type Handlers = { [K in keyof ProxyApi]: (...args: Parameters<ProxyApi[K]>) => Promise<ReturnType<ProxyApi[K]>> | ReturnType<ProxyApi[K]> }

export function proxyHandlers(): Handlers {
  return {
    proxyTest: (settings, target) => proxyRouter.test({ ...normalizeProxySettings(settings), password: settings.password }, target)
  }
}
