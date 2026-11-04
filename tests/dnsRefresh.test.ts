import * as dns from 'dns'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshDnsServers } from '../src/main/net/dns'

describe('DNS servers', () => {
  const system = new dns.Resolver().getServers()
  afterEach(() => {
    dns.setServers(system)
  })

  it('follows the system after a network change', () => {
    // As if these were the servers at startup and the network has changed since.
    dns.setServers(['192.0.2.53'])
    refreshDnsServers()
    expect(dns.getServers()).toEqual(system)
  })
})
