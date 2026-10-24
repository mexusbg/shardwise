import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ApiResponse } from '@shared/api'

/** Thin string-only bridge; EJSON (de)serialisation happens in the renderer. */
const bridge = {
  invoke: (method: string, payload: string): Promise<ApiResponse> => ipcRenderer.invoke('api', method, payload),
  on: (cb: (channel: string, payload: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, channel: string, payload: string): void => cb(channel, payload)
    ipcRenderer.on('event', listener)
    return () => ipcRenderer.off('event', listener)
  },
  platform: process.platform,
  /** Zoom of the whole window (Settings → Interface zoom). */
  setZoomFactor: (factor: number): void => webFrame.setZoomFactor(factor)
}

contextBridge.exposeInMainWorld('bridge', bridge)

export type Bridge = typeof bridge
