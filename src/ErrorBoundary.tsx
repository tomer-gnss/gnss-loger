import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

/**
 * Contains a failure to one part of the page. Without it React unmounts the whole app on any
 * render error — a single malformed log would blank the screen and stop live tracking.
 */
type Props = { children: ReactNode; label: string; resetKey?: unknown }
type State = { failed: boolean; key: unknown }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  // New input (e.g. another log loaded) clears a previous failure.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <section className="status-card bad" role="alert">
        <AlertTriangle size={22} />
        <div>
          <h2>{this.props.label} נתקל בשגיאה</h2>
          <p>שאר האתר ממשיך לעבוד. אם זה קרה אחרי טעינת קובץ, ייתכן שהקובץ פגום או לא נתמך.</p>
          <button className="primary-button" onClick={() => this.setState({ failed: false })}><RotateCcw size={18} /> נסה שוב</button>
        </div>
      </section>
    )
  }
}
