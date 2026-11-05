import { create } from 'zustand'

/** Side panels folded to a thin strip: the connection sidebar and the Filter Builder. Remembered across restarts. */
export type FoldPanel = 'sidebar' | 'vqb'

const KEY: Record<FoldPanel, string> = { sidebar: 'shardwise.fold.sidebar', vqb: 'shardwise.fold.vqb' }

function read(p: FoldPanel): boolean {
  try {
    return localStorage.getItem(KEY[p]) === '1'
  } catch {
    return false
  }
}

interface FoldState {
  sidebar: boolean
  vqb: boolean
  setFolded: (p: FoldPanel, folded: boolean) => void
  toggle: (p: FoldPanel) => void
}

export const useFolds = create<FoldState>((set, get) => ({
  sidebar: read('sidebar'),
  vqb: read('vqb'),
  setFolded: (p, folded) => {
    try {
      if (folded) localStorage.setItem(KEY[p], '1')
      else localStorage.removeItem(KEY[p])
    } catch {
      // Storage unavailable: the fold still applies for this session.
    }
    set({ [p]: folded } as Pick<FoldState, FoldPanel>)
  },
  toggle: (p) => get().setFolded(p, !get()[p])
}))
