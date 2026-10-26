import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Button, Input, LogoMark, setLite, setTheme } from "@rulebox/ui";
import type { AdminExitView } from "@rulebox/types";

import { useTauriEvent } from "../lib/events";
import { call, isTauri } from "../lib/tauri";
import { afterAnswer, filterPin, MESSAGES, present, type Phase } from "./logic";

/**
 * The hidden administrator exit. It has its own window and page so it works
 * when the rest of the shell does not (Section 7.11): no shared store, no
 * animation, no icons. The agent checks the PIN; this page only asks for it
 * and shows what the agent answers.
 */
export function AdminExit() {
  const [view, setView] = useState<AdminExitView | null>(null);
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [now, setNow] = useState(() => Date.now());
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  // A new view: remember when the link first went down, forget it when it is back.
  const applyView = useCallback((next: AdminExitView) => {
    setView(next);
    setWaitingSince((since) => (next.link === "linked" ? null : (since ?? Date.now())));
  }, []);

  // What the dialog needs to know, once at the start and again when it changes.
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let current = true;
    void call("admin_exit_state", {}).then(
      (next) => {
        if (current) applyView(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [applyView]);
  useTauriEvent<AdminExitView>("exit://state", applyView);

  // The clock only runs while something counts down or waits.
  const link = view?.link;
  const counting = phase.kind === "locked" || phase.kind === "unavailable" || (link !== undefined && link !== "linked");
  useEffect(() => {
    if (!counting) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [counting]);

  const shown = view ? present(view, phase, pin, now, waitingSince) : null;

  // The dialog goes away by itself when the exit was turned off.
  useEffect(() => {
    if (shown?.closes) {
      close();
    }
  }, [shown?.closes]);

  // Focus the field whenever it is usable (also when it comes back).
  const disabled = shown?.fieldDisabled ?? true;
  useEffect(() => {
    if (!disabled) {
      document.getElementById("exit-pin")?.focus();
    }
  }, [disabled]);

  // Same theme and Lite setting as the rest of Rulebox.
  useEffect(() => {
    if (view) {
      setTheme(view.theme);
      setLite(view.lite);
    }
  }, [view]);

  function close() {
    if (isTauri()) {
      void call("admin_exit_close", {});
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!shown?.canSubmit || !isTauri()) {
      return;
    }
    const sent = pin;
    // The PIN is cleared at once: it is never kept, and never sent twice.
    setPin("");
    setPhase({ kind: "checking" });
    let next: Phase | "close";
    try {
      next = afterAnswer(await call("admin_exit_submit", { pin: sent }), Date.now());
    } catch {
      next = { kind: "unavailable", since: Date.now() };
    }
    setNow(Date.now());
    if (next === "close") {
      close();
    } else {
      setPhase(next);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  return (
    <main style={page} onKeyDown={onKeyDown}>
      <form style={card} onSubmit={(event) => void submit(event)} aria-labelledby="exit-title">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <LogoMark size={36} />
          <div>
            <h1 id="exit-title" style={{ margin: 0, fontSize: 19, fontWeight: 600 }}>
              Administrator exit
            </h1>
            <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--rb-muted)" }}>
              Enter the administrator PIN.
            </p>
          </div>
        </div>

        <Input
          id="exit-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={12}
          aria-label="Administrator PIN"
          placeholder="PIN (4 to 12 digits)"
          disabled={disabled}
          value={pin}
          onChange={(event) => setPin(filterPin(event.target.value))}
        />

        {/* The message is its own live region (alert or status), so this wrapper is not one too. */}
        <div style={{ minHeight: 44 }}>
          {shown?.message ? (
            <p
              role={shown.tone === "error" ? "alert" : "status"}
              style={{
                margin: 0,
                fontSize: 13.5,
                fontWeight: 500,
                color: shown.tone === "error" ? "var(--rb-danger-text)" : "var(--rb-ink)",
              }}
            >
              <MessageText message={shown.message} />
            </p>
          ) : null}
          {shown?.recovery ? (
            <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--rb-muted)" }}>{MESSAGES.recovery}</p>
          ) : null}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={close} disabled={phase.kind === "signingOut"}>
            Cancel
          </Button>
          <Button type="submit" disabled={!shown?.canSubmit}>
            Sign out to Windows
          </Button>
        </div>
      </form>
    </main>
  );
}

/**
 * The lockout line counts down every second. The count is drawn but hidden from
 * screen readers (the alert would repeat every second); they hear whole minutes.
 */
function MessageText({ message }: { message: string }) {
  const locked = /^(Too many tries\. Try again in )(\d+):(\d{2})\.$/.exec(message);
  if (!locked) {
    return <>{message}</>;
  }
  const minutes = Math.max(1, Number(locked[2]) + (Number(locked[3]) > 0 ? 1 : 0));
  return (
    <>
      {locked[1]}
      <span aria-hidden="true">
        {locked[2]}:{locked[3]}
      </span>
      <span className="rb-sr-only">{minutes === 1 ? "about a minute" : `about ${minutes} minutes`}</span>.
    </>
  );
}

const page: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: 16,
  boxSizing: "border-box",
  background: "var(--rb-bg)",
  color: "var(--rb-ink)",
  fontFamily: "var(--rb-font-sans)",
};

const card: CSSProperties = {
  width: "100%",
  maxWidth: 400,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  borderRadius: 22,
  background: "var(--rb-surface)",
  border: "1px solid var(--rb-line)",
  boxShadow: "var(--rb-shadow-lg)",
};
