import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'

interface WindowState {
  bounds: Partial<Rectangle> & { width: number; height: number }
  maximized: boolean
}

const file = (dir: string): string => join(dir, 'window-state.json')

export function loadWindowState(dir: string): WindowState {
  const fallback: WindowState = { bounds: { width: 1400, height: 900 }, maximized: false }
  try {
    const s = JSON.parse(readFileSync(file(dir), 'utf8')) as WindowState
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      const b = s.bounds
      return b.x !== undefined && b.y !== undefined && b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
    })
    return visible ? s : { ...s, bounds: { width: s.bounds.width, height: s.bounds.height } }
  } catch {
    return fallback
  }
}

export function trackWindowState(win: BrowserWindow, dir: string): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed()) return
      const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
      try {
        writeFileSync(file(dir), JSON.stringify(state))
      } catch {
        // Not worth interrupting the user over.
      }
    }, 500)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
  win.on('close', save)
}
