import { generateKeyPairSync, randomBytes } from 'crypto'

/**
 * A fresh Ed25519 host key for an ssh2 test `Server`, in OpenSSH format.
 *
 * Not `utils.generateKeyPairSync('ed25519')` from ssh2: its converter strips "leading zero bytes" off the DER
 * BIT STRING to drop the unused-bits byte, so when the 32-byte public key itself starts with 0x00 (1 key in 256)
 * it is cut to 31 bytes and `new Server()` throws "Cannot parse privateKey: Malformed OpenSSH private key".
 * Here the raw keys come from Node's JWK export and are encoded as-is.
 */
export function ed25519HostKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const pub = Buffer.from(jwk.x!, 'base64url')
  const seed = Buffer.from(jwk.d!, 'base64url')
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const str = (s: Buffer | string): Buffer => {
    const b = Buffer.from(s)
    return Buffer.concat([u32(b.length), b])
  }
  const name = 'ssh-ed25519'
  const pubBlob = Buffer.concat([str(name), str(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([check, check, str(name), str(pub), str(Buffer.concat([seed, pub])), str('')])
  const pad = (8 - (priv.length % 8)) % 8
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(pubBlob), str(priv)])
  const b64 = body.toString('base64').replace(/.{1,70}/g, '$&\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`
}
