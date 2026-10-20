import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";

import { installExitKey } from "../lib/exitKey";
import { call, isTauri } from "../lib/tauri";
import { AdminExit } from "./AdminExit";

/** If this tiny page ever fails, the person can still close it and try again. */
class Fallback extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <main style={{ padding: 24, fontFamily: "sans-serif" }}>
        <p>The administrator exit could not be shown.</p>
        <button type="button" onClick={() => isTauri() && void call("admin_exit_close", {})}>
          Close
        </button>
      </main>
    );
  }
}

installExitKey();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fallback>
      <AdminExit />
    </Fallback>
  </StrictMode>,
);
