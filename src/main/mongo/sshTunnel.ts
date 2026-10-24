import { promises as fs } from 'fs'
import type { Duplex } from 'stream'
import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import type { SshConfig } from '@shared/connection'
import { listenForward, listenSocks } from '../net/socksServer'
import type { LocalListener } from '../net/socksServer'

export type PortForward = LocalListener

export interface Tunnel {
  /** What carries the traffic: an SSH connection or a proxy server (see ../net/proxy.ts). */
  kind?: 'ssh' | 'proxy'
  /** Local SOCKS5 proxy endpoint to hand to the MongoDB driver (proxyHost / proxyPort). */
  host: string
  port: number
  /** Random per-tunnel SOCKS5 credentials (RFC 1929), required by the proxy. */
  username: string
  password: string
  close(): Promise<void>
  onClose(cb: (err?: Error) => void): void
  /**
   * Open a local TCP listener on 127.0.0.1 that forwards every connection to `host:port` through the tunnel
   * (for external tools that cannot use the SOCKS proxy). Close it when done; it is also closed together
   * with the tunnel.
   */
  forwardPort(host: string, port: number): Promise<PortForward>
}

async function sshConnectConfig(cfg: SshConfig): Promise<ConnectConfig> {
  if (!cfg.host) throw new Error('SSH host is required')
  const c: ConnectConfig = {
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000
  }
  if (cfg.method === 'key') {
    if (!cfg.keyFile) throw new Error('SSH private key file is required')
    c.privateKey = await fs.readFile(cfg.keyFile)
    if (cfg.passphrase) c.passphrase = cfg.passphrase
  } else {
    c.password = cfg.password ?? ''
    c.tryKeyboard = true
  }
  return c
}

/**
 * Open an SSH connection and expose it as a local SOCKS5 proxy. `sock`: an already open connection to the
 * SSH server (e.g. a tunnel through an HTTP / SOCKS proxy) to run SSH over instead of dialling the host.
 */
export async function openSshTunnel(cfg: SshConfig, sock?: Duplex): Promise<Tunnel> {
  const connectCfg = await sshConnectConfig(cfg)
  if (sock) {
    connectCfg.sock = sock
    // Proxy sockets come back paused; ssh2 attaches its reader synchronously in connect().
    sock.resume()
  }
  const ssh = new Client()
  const closeCbs: ((err?: Error) => void)[] = []
  let closed = false

  await new Promise<void>((resolve, reject) => {
    ssh.once('ready', () => resolve())
    ssh.once('error', (e) => reject(new Error(`SSH: ${e.message}`)))
    if (cfg.method !== 'key') {
      ssh.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => cfg.password ?? '')))
    }
    ssh.connect(connectCfg)
  })

  const forward = (host: string, port: number): Promise<NodeJS.ReadWriteStream> =>
    new Promise((resolve, reject) => {
      ssh.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
    })

  const socks = await listenSocks(forward)
  const forwards = new Set<PortForward>()

  const shutdown = (err?: Error): void => {
    if (closed) return
    closed = true
    socks.close()
    for (const f of forwards) f.close()
    ssh.end()
    closeCbs.forEach((cb) => cb(err))
  }
  ssh.on('error', (e) => shutdown(e))
  ssh.on('close', () => shutdown(new Error('SSH connection closed')))

  const forwardPort = async (host: string, targetPort: number): Promise<PortForward> => {
    if (closed) throw new Error('SSH tunnel is closed')
    const listener = await listenForward(() => forward(host, targetPort))
    const fwd: PortForward = {
      port: listener.port,
      close: () => {
        forwards.delete(fwd)
        listener.close()
      }
    }
    forwards.add(fwd)
    return fwd
  }

  return {
    kind: 'ssh',
    host: socks.host,
    port: socks.port,
    username: socks.username,
    password: socks.password,
    close: async () => shutdown(),
    onClose: (cb) => void closeCbs.push(cb),
    forwardPort
  }
}
