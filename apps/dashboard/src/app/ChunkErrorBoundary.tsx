import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@rulebox/ui";
import IconDanger from "~icons/solar/danger-circle-linear";
import { isChunkLoadError, RELOAD_KEY, shouldAutoReload } from "../lib/chunkError";
import { readStorage, writeStorage } from "../lib/storage";
import { strings } from "../lib/strings";

interface Props {
  children: ReactNode;
  /** Changing this clears the error (for example the route). */
  resetKey?: unknown;
  /** Full page (around the router) or inside the signed-in layout. */
  fullPage?: boolean;
  /** For tests: what "reload the page" does. */
  reload?: () => void;
}

interface State {
  error: unknown;
  key: unknown;
  /** Offline: Try again waits for the connection. */
  waiting: boolean;
}

/**
 * Catches a screen chunk that failed to download (flaky network, or a new
 * deploy removed the old files) and shows "This part of the page didn't load"
 * with Try again instead of a blank page.
 *
 * Online, it first reloads the page by itself, at most once a minute (a new
 * deploy is fixed by a fresh index.html; the guard stops a loop). Try again
 * reloads the page too: Chromium remembers a failed `import()` for the page's
 * lifetime, so importing again in place does not work (checked 2026-10-27).
 * Offline, it waits for the connection before reloading, so the browser never
 * shows its own offline page. Any other error goes to the next boundary.
 */
export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey, waiting: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey, waiting: false };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (!isChunkLoadError(error)) return;
    console.warn("Rulebox dashboard: a code chunk failed to load", error, info.componentStack);
    const last = Number(readStorage(RELOAD_KEY, "session")) || null;
    if (shouldAutoReload(Date.now(), last, navigator.onLine)) {
      writeStorage(RELOAD_KEY, String(Date.now()), "session");
      this.reload();
    }
  }

  componentWillUnmount() {
    window.removeEventListener("online", this.onOnline);
  }

  private reload = () => (this.props.reload ?? (() => window.location.reload()))();

  private onOnline = () => {
    window.removeEventListener("online", this.onOnline);
    this.reload();
  };

  private retry = () => {
    if (navigator.onLine) {
      this.reload();
      return;
    }
    this.setState({ waiting: true });
    window.addEventListener("online", this.onOnline);
  };

  render() {
    const { error, waiting } = this.state;
    if (!error) return this.props.children;
    // Not a chunk error: let the region / app boundary above handle it.
    if (!isChunkLoadError(error)) throw error;
    const panel = (
      <div className="dash-region-error" role="alert">
        <span className="dash-region-error__icon" aria-hidden="true">
          <IconDanger />
        </span>
        <div className="dash-region-error__text">
          <p className="dash-region-error__title">{strings.common.regionFailed}</p>
          <p className="dash-region-error__detail">{waiting ? strings.app.reconnecting : strings.common.regionFailedDetail}</p>
        </div>
        <Button variant="ghost" className="dash-btn--sm" onClick={this.retry} disabled={waiting}>
          {strings.common.tryAgain}
        </Button>
      </div>
    );
    return this.props.fullPage ? <main className="dash-fullpage">{panel}</main> : panel;
  }
}
