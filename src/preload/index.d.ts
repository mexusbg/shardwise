import type { ApiResponse } from '../shared/api'

declare global {
  interface Window {
    bridge: {
      invoke(method: string, payload: string): Promise<ApiResponse>
      on(cb: (channel: string, payload: string) => void): () => void
      platform: string
      setZoomFactor?(factor: number): void
    }
  }
}

export {}
