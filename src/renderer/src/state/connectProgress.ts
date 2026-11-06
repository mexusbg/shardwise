import { create } from 'zustand'
import type { ConnectStep } from '@shared/api'
import { onEvent } from '../lib/api'

/** One connect attempt shown in the progress dialog. */
export interface ConnectAttempt {
  id: string
  configId: string
  name: string
  color?: string
  steps: ConnectStep[]
  /** The servers being contacted, from the start of the "Connect" stage. */
  servers?: string
  status: 'running' | 'failed'
  error?: string
  startedAt: number
  /** Quick connects never show the dialog: it appears after SHOW_AFTER_MS, or at once on failure. */
  visible: boolean
}

/** Attempts that finish within this time never flash the dialog. */
export const SHOW_AFTER_MS = 350

export const useConnectAttempts = create<{ list: ConnectAttempt[] }>(() => ({ list: [] }))

const patch = (id: string, fn: (a: ConnectAttempt) => Partial<ConnectAttempt>): void =>
  useConnectAttempts.setState((s) => ({ list: s.list.map((a) => (a.id === id ? { ...a, ...fn(a) } : a)) }))

/** Adds or updates the step of that name; a finished step keeps the detail it started with when it reports none. */
export function applyStep(steps: ConnectStep[], step: ConnectStep): ConnectStep[] {
  const i = steps.findIndex((s) => s.name === step.name)
  if (i < 0) return [...steps, step]
  const next = steps.slice()
  next[i] = { ...step, detail: step.detail ?? steps[i].detail }
  return next
}

let seq = 0

export function startAttempt(configId: string, name: string, color?: string): string {
  const id = `connect-${Date.now().toString(36)}-${++seq}`
  useConnectAttempts.setState((s) => ({ list: [...s.list, { id, configId, name, color, steps: [], status: 'running', startedAt: Date.now(), visible: false }] }))
  setTimeout(() => patch(id, () => ({ visible: true })), SHOW_AFTER_MS)
  return id
}

export function stepAttempt(id: string, step: ConnectStep): void {
  patch(id, (a) => ({ steps: applyStep(a.steps, step), ...(step.name === 'Connect' && step.state === 'running' && step.detail ? { servers: step.detail } : {}) }))
}

/** A failed attempt stays in the dialog (with its error) until the user closes it or tries again. */
export function failAttempt(id: string, error: string): void {
  patch(id, (a) => ({
    status: 'failed',
    error,
    visible: true,
    // A stage still marked running is the one that failed.
    steps: a.steps.map((s) => (s.state === 'running' ? { ...s, state: 'failed' } : s))
  }))
}

export function endAttempt(id: string): void {
  useConnectAttempts.setState((s) => ({ list: s.list.filter((a) => a.id !== id) }))
}

// Stages reported by the main process while it opens the connection.
onEvent('connect:progress', ({ attemptId, ...step }) => stepAttempt(attemptId, step))
