import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  children: ReactNode
  /** Shown in the fallback, e.g. the tab title. */
  label?: string
}

interface State {
  error: Error | null
}

/** Keeps one broken view from blanking the whole window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`View crashed${this.props.label ? ` (${this.props.label})` : ''}:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="result-empty" style={{ flex: 1 }}>
        <Icon name="warn" size={28} style={{ color: 'var(--danger)' }} />
        <div style={{ margin: '10px 0 6px', fontWeight: 600 }}>{this.props.label ? `${this.props.label} ran into a problem` : 'This view ran into a problem'}</div>
        <div className="mono selectable" style={{ fontSize: 12, maxWidth: 640, margin: '0 auto 12px' }}>
          {this.state.error.message}
        </div>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
