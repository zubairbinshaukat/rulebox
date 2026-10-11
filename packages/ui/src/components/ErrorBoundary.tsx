import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";
import { Panel } from "./Panel";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short heading shown above the error message. */
  title?: string;
}

interface State {
  error: Error | null;
}

/** Catches render errors (e.g. a failed Convex query) and shows a retry panel instead of a blank screen. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Rulebox UI error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <Panel style={{ maxWidth: 420, padding: 28, display: "flex", flexDirection: "column", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 500 }}>
            {this.props.title ?? "Something went wrong"}
          </h1>
          <p style={{ margin: 0, color: "var(--rb-muted)", lineHeight: 1.5 }}>{error.message}</p>
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </Panel>
      </div>
    );
  }
}
