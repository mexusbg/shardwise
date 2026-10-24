import { safeStorage } from 'electron'
import type { SecretCodec } from './store'

const PLAIN = 'plain:'

export interface SecretStorageStatus {
  /** False when secrets are stored without a real OS keychain (Linux `basic_text`, or no encryption at all). */
  secure: boolean
  /** `dpapi` (Windows), `keychain` (macOS), the Linux backend from safeStorage, or `none`. */
  backend: string
}

/** How saved passwords are protected. Call after the app is ready. */
export async function secretStorageStatus(): Promise<SecretStorageStatus> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return { secure: false, backend: 'none' }
  if (process.platform === 'win32') return { secure: true, backend: 'dpapi' }
  if (process.platform === 'darwin') return { secure: true, backend: 'keychain' }
  const backend = safeStorage.getSelectedStorageBackend()
  return { secure: backend !== 'basic_text' && backend !== 'unknown', backend }
}

let warned = false

async function warnIfInsecure(): Promise<void> {
  if (warned) return
  const s = await secretStorageStatus()
  if (s.secure || warned) return
  warned = true
  console.warn(
    s.backend === 'none'
      ? 'Secret storage: OS encryption is unavailable; saved passwords are stored unencrypted.'
      : `Secret storage: no OS keyring found (backend "${s.backend}"); saved passwords are only obfuscated with a fixed key. Install and unlock a keyring (e.g. gnome-keyring or KWallet) to protect them.`
  )
}

/** Encrypts secrets with Electron safeStorage; falls back to base64 (`plain:`) when encryption is unavailable. */
export const secretCodec: SecretCodec = {
  encrypt: async (plain) => {
    await warnIfInsecure()
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return `${PLAIN}${Buffer.from(plain).toString('base64')}`
    return (await safeStorage.encryptStringAsync(plain)).toString('base64')
  },
  decrypt: async (stored) => {
    if (stored.startsWith(PLAIN)) return Buffer.from(stored.slice(PLAIN.length), 'base64').toString()
    return (await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))).result
  }
}
