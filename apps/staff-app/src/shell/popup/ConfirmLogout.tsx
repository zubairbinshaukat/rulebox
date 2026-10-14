import { useEffect, useState } from "react";
import { Button } from "@rulebox/ui";

import { call } from "../../lib/tauri";

/** "Log out? These apps will be closed…" Nothing open: no list. */
export function ConfirmLogout() {
  const [apps, setApps] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void call("closing_apps", {}).then((names) => {
      if (!cancelled) {
        setApps(names);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      data-testid="confirm-logout"
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 16 }}>Log out?</div>
      {apps && apps.length > 0 ? (
        <div style={{ minHeight: 0, overflow: "auto" }}>
          <div style={{ fontSize: 13.5, color: "var(--rb-muted)", marginBottom: 6 }}>
            These apps will be closed:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
            {apps.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--rb-muted)" }}>
        Unsaved work may be lost.
      </p>
      <div style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost" disabled={busy} onClick={() => void call("popup_close", {})}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void call("sign_out", {});
          }}
        >
          Log out
        </Button>
      </div>
    </div>
  );
}
