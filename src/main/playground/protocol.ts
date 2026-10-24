import type { MongoClientOptions } from 'mongodb'
import type { PlaygroundLanguage, PlaygroundLog, PlaygroundResult } from '@shared/api'
import type { ShellEvalOptions, ShellOpLevel, ShellStartupReport } from '@shared/shellOptions'
import type { StartupScript } from './core'

/** workerData passed to the playground worker. */
export interface WorkerInit {
  uri: string
  options: MongoClientOptions
  db: string
  code: string
  language: PlaygroundLanguage
  /** Name of a read-only connection: the worker's client refuses writes. */
  readOnly?: string
  /** Shell startup scripts to run first (Settings → Shell & Playground → also run in the playground). */
  startup?: StartupScript[]
  startupErrors?: string[]
}

/** Result fields produced by the worker (the runner adds runId and logs). */
export type ExecResult = Omit<PlaygroundResult, 'runId' | 'logs'>

/** Messages from the worker. `data` of 'done' is an encodeIpc()'d ExecResult so BSON values survive. */
export type WorkerMessage = { t: 'log'; log: PlaygroundLog } | { t: 'done'; data: string }

/** Largest array shown as the result. */
export const RESULT_LIMIT = 1000

/** workerData of a long-lived shell session worker (same bundle as the playground worker). */
export interface SessionInit {
  mode: 'session'
  uri: string
  options: MongoClientOptions
  db: string
  /** Name of a read-only connection: the worker's client refuses writes. */
  readOnly?: string
  /** Scripts run once connected, before 'ready' (errors are reported, the session still starts). */
  startup?: StartupScript[]
}

/** Messages to a session worker. 'confirmed' answers a 'confirm' message. */
export type SessionRequest = { t: 'eval'; id: number; code: string; opts?: ShellEvalOptions } | { t: 'close' } | { t: 'confirmed'; id: number; ok: boolean }

/** What the worker asks the user to approve. */
export interface ConfirmAsk {
  level: ShellOpLevel
  summary: string
  op: string
}

/**
 * Messages from a session worker. `data` of 'done' is an encodeIpc()'d ShellExecResult; 'ready' carries the
 * startup script reports (plain data), 'confirm' asks to approve a write.
 */
export type SessionMessage =
  | { t: 'ready'; startup?: ShellStartupReport[] }
  | { t: 'fatal'; error: string }
  | { t: 'log'; log: PlaygroundLog }
  | { t: 'done'; id: number; data: string }
  | { t: 'confirm'; id: number; ask: ConfirmAsk }

/** Result of one shell evaluation: the current database and whether `it` has more documents. */
export type ShellExecResult = ExecResult & { db: string; more?: boolean }
