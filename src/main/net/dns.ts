import * as dns from 'dns'

/**
 * Points the resolver behind `dns.resolve*` (SRV / TXT lookups of mongodb+srv connections) at the system's current
 * DNS servers. Node reads them once at startup, so after a network or VPN change a long-running app would keep
 * asking servers that are gone and every new mongodb+srv connection would fail until a restart. A new Resolver
 * reads the current system configuration.
 */
export function refreshDnsServers(): void {
  try {
    const current = new dns.Resolver().getServers()
    if (current.length && current.join() !== dns.getServers().join()) dns.setServers(current)
  } catch {
    // A lookup in progress keeps the old servers; the next connect tries again.
  }
}
