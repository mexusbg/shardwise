import { randomUUID } from 'crypto'
import type { JobProgress } from '@shared/api'
import { Job } from '../sql/job'

export type JobState = 'done' | 'error' | 'cancelled'

const isAbort = (e: unknown, signal: AbortSignal): boolean => signal.aborted || (e as Error)?.name === 'AbortError'

/** Runs background jobs that report through `job:progress`; the body's return value is the final message. */
export class JobRunner {
  private jobs = new Map<string, Job>()

  constructor(private emit: (p: JobProgress) => void) {}

  run(title: string, body: (job: Job) => Promise<string>, after?: (state: JobState, error?: string) => void): string {
    const job = new Job(randomUUID(), title, this.emit)
    this.jobs.set(job.id, job)
    job.update({ message: 'Starting…' })
    void (async () => {
      let state: JobState = 'done'
      let error: string | undefined
      try {
        const message = await body(job)
        job.update({ message })
        if (job.signal.aborted) state = 'cancelled'
      } catch (e) {
        if (isAbort(e, job.signal)) {
          state = 'cancelled'
          job.update({ message: 'Cancelled' })
        } else {
          state = 'error'
          error = (e as Error)?.message || String(e)
          job.update({ message: error })
        }
      } finally {
        this.jobs.delete(job.id)
        try {
          after?.(state, error)
        } finally {
          job.finish(state, error)
        }
      }
    })()
    return job.id
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.ctrl.abort()
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) j.ctrl.abort()
  }
}
