import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { TasksApi, TasksEvents } from '@shared/tasksApi'

type Promisified = { [K in keyof TasksApi]: (...args: Parameters<TasksApi[K]>) => Promise<Awaited<ReturnType<TasksApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** Tasks & scheduler methods, invoked over the same IPC channel and codec as `api`. */
export const tasksApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified

type ChangedListener = (e: TasksEvents['tasks:changed']) => void
const changed = new Set<ChangedListener>()
let subscribed = false

/** `tasks:changed` push events (a task, its run state or its history changed). */
export function onTasksChanged(cb: ChangedListener): () => void {
  if (!subscribed) {
    subscribed = true
    window.bridge.on((channel, payload) => {
      if (channel !== 'tasks:changed') return
      const value = decodeIpc(payload) as TasksEvents['tasks:changed']
      changed.forEach((l) => l(value))
    })
  }
  changed.add(cb)
  return () => void changed.delete(cb)
}
