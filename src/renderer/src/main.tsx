import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

// One-time move of UI preferences, drafts and shell history saved under the old app name.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('mongoguru.')) continue
    const next = 'shardwise.' + key.slice('mongoguru.'.length)
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!)
    localStorage.removeItem(key)
  }
} catch {
  // Storage unavailable: nothing to migrate.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Last line of defence: an error that escapes a tab (e.g. while it closes) shows here instead of a blank window. */}
    <ErrorBoundary label="Shardwise">
      <App />
    </ErrorBoundary>
  </StrictMode>
)
