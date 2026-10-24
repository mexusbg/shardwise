import type { JobProgress } from '@shared/api'

const EMIT_INTERVAL_MS = 100
const MAX_LOG_LINES = 500

export const fmt = (n: number): string => n.toLocaleString('en-US')
export const plural = (n: number, w: string): string => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`

export class AbortError extends Error {
  name = 'AbortError'
  constructor() {
    super('Cancelled')
  }
}

/** Progress of one migration job, emitted at most every 100 ms plus the final update (as in transfer/jobs.ts). */
export class Job {
  readonly ctrl = new AbortController()
  done = 0
  total?: number
  message?: string
  private log: string[] = []
  private dropped = 0
  private lastEmit = 0
  private timer: NodeJS.Timeout | null = null
  private finished = false

  constructor(
    readonly id: string,
    readonly title: string,
    private emit: (p: JobProgress) => void
  ) {}

  get signal(): AbortSignal {
    return this.ctrl.signal
  }

  check(): void {
    if (this.signal.aborted) throw new AbortError()
  }

  addLog(line: string): void {
    this.log.push(line)
    if (this.log.length > MAX_LOG_LINES) {
      this.log.shift()
      this.dropped++
    }
    this.touch()
  }

  update(p: { done?: number; total?: number; message?: string }): void {
    if (p.done !== undefined) this.done = p.done
    if (p.total !== undefined) this.total = p.total
    if (p.message !== undefined) this.message = p.message
    this.touch()
  }

  private snapshot(state: JobProgress['state'], error?: string): JobProgress {
    const log = this.dropped ? [`… ${fmt(this.dropped)} earlier lines omitted`, ...this.log] : [...this.log]
    const p: JobProgress = { jobId: this.id, title: this.title, done: this.done, state, log }
    if (this.total !== undefined) p.total = this.total
    if (this.message !== undefined) p.message = this.message
    if (error !== undefined) p.error = error
    return p
  }

  private touch(): void {
    if (this.finished) return
    const wait = this.lastEmit + EMIT_INTERVAL_MS - Date.now()
    if (wait <= 0) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), wait)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.finished) return
    this.lastEmit = Date.now()
    this.emit(this.snapshot('running'))
  }

  finish(state: 'done' | 'error' | 'cancelled', error?: string): void {
    if (this.finished) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.finished = true
    this.emit(this.snapshot(state, error))
  }
}
