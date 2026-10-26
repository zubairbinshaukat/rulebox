import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@rulebox/ui";
import { messageFor } from "../lib/errors";
import { strings } from "../lib/strings";

interface State {
  error: unknown;
}

/**
 * The last-resort boundary around the whole dashboard. Unlike the generic
 * `@rulebox/ui` one it never shows an error's own message (a server message
 * or a stack hint): only the sentence for a known error code, else the
 * generic one.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Rulebox dashboard error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="dash-fullpage">
        <div className="dash-card dash-card--pad" role="alert" style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 12 }}>
          <h1 style={{ fontSize: 19 }}>{strings.app.crashTitle}</h1>
          <p className="dash-muted">{messageFor(this.state.error)}</p>
          <div>
            <Button onClick={() => this.setState({ error: null })}>{strings.common.tryAgain}</Button>
          </div>
        </div>
      </main>
    );
  }
}
