import type { ProxySettings, ProxyTestResult } from './proxy'

/** Settings → Network & tools methods, invoked over the same IPC channel as `Api`. */
export interface ProxyApi {
  /**
   * Open a tunnel to `target` (`host:port` or a URL) with the given, possibly unsaved, settings and close it again.
   * A missing `settings.password` uses the saved one.
   */
  proxyTest(settings: ProxySettings, target: string): ProxyTestResult
}
