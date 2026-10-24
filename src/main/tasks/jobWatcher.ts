import type { JobProgress } from '@shared/api'

const KEEP_FINISHED = 200

/**
 * Lets the main process await jobs started through Transfers / Comparisons / Migrations / Masking. Feed it every
 * `JobProgress` those classes emit (the same callback that forwards them to the renderer).
 */
export class JobWatcher {
  private finished = new Map<string, JobProgress>()
  private waiters = new Map<string, Set<(p: JobProgress) => void>>()

  readonly feed = (p: JobProgress): void => {
    const set = this.waiters.get(p.jobId)
    if (p.state === 'running') {
      set?.forEach((w) => w(p))
      return
    }
    this.finished.set(p.jobId, p)
    if (this.finished.size > KEEP_FINISHED) this.finished.delete(this.finished.keys().next().value!)
    if (!set) return
    this.waiters.delete(p.jobId)
    set.forEach((w) => w(p))
  }

  /** Resolves with the final progress (done / error / cancelled); `onProgress` sees the running updates. */
  wait(jobId: string, onProgress?: (p: JobProgress) => void): Promise<JobProgress> {
    const done = this.finished.get(jobId)
    if (done) return Promise.resolve(done)
    return new Promise((resolve) => {
      let set = this.waiters.get(jobId)
      if (!set) this.waiters.set(jobId, (set = new Set()))
      set.add((p) => {
        if (p.state === 'running') onProgress?.(p)
        else resolve(p)
      })
    })
  }
}
