import net from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'

/** Opens the upstream stream for one proxied connection. */
export type Forward = (host: string, port: number) => Promise<NodeJS.ReadWriteStream>

const sameSecret = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

const destroyStream = (s: NodeJS.ReadWriteStream): void => (s as unknown as { destroy?: () => void }).destroy?.()

/** Minimal SOCKS5 server side (username/password auth, CONNECT only) over a buffered socket. */
export function handleSocks(socket: net.Socket, creds: { username: Buffer; password: Buffer }, forward: Forward): void {
  let buf = Buffer.alloc(0)
  let stage: 'greeting' | 'auth' | 'request' | 'piping' = 'greeting'

  const refuse = (reply: number[]): void => {
    socket.off('data', onData)
    socket.end(Buffer.from(reply))
  }
  const fail = (code: number): void => refuse([5, code, 0, 1, 0, 0, 0, 0, 0, 0])

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    if (stage === 'greeting') {
      if (buf.length < 2) return
      const n = buf[1]
      if (buf.length < 2 + n) return
      if (buf[0] !== 5) return void socket.destroy()
      const methods = buf.subarray(2, 2 + n)
      buf = buf.subarray(2 + n)
      if (!methods.includes(2)) return refuse([5, 0xff])
      socket.write(Buffer.from([5, 2]))
      stage = 'auth'
    }
    if (stage === 'auth') {
      if (buf.length < 2) return
      const ulen = buf[1]
      if (buf.length < 3 + ulen) return
      const plen = buf[2 + ulen]
      if (buf.length < 3 + ulen + plen) return
      const user = buf.subarray(2, 2 + ulen)
      const pass = buf.subarray(3 + ulen, 3 + ulen + plen)
      const ok = buf[0] === 1 && sameSecret(user, creds.username) && sameSecret(pass, creds.password)
      buf = buf.subarray(3 + ulen + plen)
      if (!ok) return refuse([1, 1])
      socket.write(Buffer.from([1, 0]))
      stage = 'request'
    }
    if (stage === 'request') {
      if (buf.length < 5) return
      const [ver, cmd, , atyp] = buf
      if (ver !== 5) return void socket.destroy()
      let host: string
      let off: number
      if (atyp === 1) {
        if (buf.length < 10) return
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
        off = 8
      } else if (atyp === 3) {
        const len = buf[4]
        if (buf.length < 5 + len + 2) return
        host = buf.subarray(5, 5 + len).toString('utf8')
        off = 5 + len
      } else if (atyp === 4) {
        if (buf.length < 22) return
        const parts: string[] = []
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
        host = parts.join(':')
        off = 20
      } else return fail(8)
      const port = buf.readUInt16BE(off)
      const rest = buf.subarray(off + 2)
      if (cmd !== 1) return fail(7)
      stage = 'piping'
      socket.off('data', onData)
      socket.pause()
      forward(host, port).then(
        (stream) => {
          if (socket.destroyed) return destroyStream(stream)
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (rest.length) stream.write(rest)
          socket.pipe(stream).pipe(socket)
          socket.resume()
          const end = (): void => {
            socket.destroy()
            destroyStream(stream)
          }
          socket.on('error', end)
          socket.on('close', end)
          stream.on('error', end)
          stream.on('close', end)
        },
        () => fail(5)
      )
    }
  }
  socket.on('data', onData)
  socket.on('error', () => socket.destroy())
}

/** A loopback listener; closing it also drops the connections it accepted. */
export interface LocalListener {
  port: number
  close(): void
}

async function listen(onSocket: (sock: net.Socket) => void, sockets: Set<net.Socket>): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    onSocket(sock)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return { server, port: (server.address() as net.AddressInfo).port }
}

export interface LocalSocks extends LocalListener {
  host: string
  /** Random per-listener SOCKS5 credentials (RFC 1929), required by the server. */
  username: string
  password: string
}

/** A SOCKS5 server on 127.0.0.1 whose CONNECT requests are served by `forward`. */
export async function listenSocks(forward: Forward): Promise<LocalSocks> {
  const username = randomBytes(12).toString('hex')
  const password = randomBytes(24).toString('hex')
  const creds = { username: Buffer.from(username), password: Buffer.from(password) }
  const sockets = new Set<net.Socket>()
  const { server, port } = await listen((sock) => handleSocks(sock, creds, forward), sockets)
  return {
    host: '127.0.0.1',
    port,
    username,
    password,
    close: () => {
      server.close()
      for (const s of sockets) s.destroy()
    }
  }
}

/** A plain TCP listener on 127.0.0.1 that pipes every connection to the stream `open` gives (port forward). */
export async function listenForward(open: () => Promise<NodeJS.ReadWriteStream>): Promise<LocalListener> {
  const sockets = new Set<net.Socket>()
  const { server, port } = await listen((sock) => {
    sock.on('error', () => sock.destroy())
    sock.pause()
    open().then(
      (stream) => {
        if (sock.destroyed) return destroyStream(stream)
        sock.pipe(stream as NodeJS.WritableStream)
        stream.pipe(sock)
        sock.resume()
        const end = (): void => {
          sock.destroy()
          destroyStream(stream)
        }
        stream.on('error', end)
        stream.on('close', end)
        sock.on('close', end)
      },
      () => sock.destroy()
    )
  }, sockets)
  return {
    port,
    close: () => {
      server.close()
      for (const s of sockets) s.destroy()
    }
  }
}
