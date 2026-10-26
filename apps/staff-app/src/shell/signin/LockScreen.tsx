import { useEffect, useRef, useState, type FormEvent } from "react";
import { Avatar, Backdrop, Button, Input, LogoMotion, Panel } from "@rulebox/ui";
import type { Employee, ShellState } from "@rulebox/types";

import { useDocumentTitle } from "../../lib/a11y";
import { call, type VerifyOutcomeDto } from "../../lib/tauri";

export interface LockScreenProps {
  shell: ShellState;
  employee: Employee;
}

function errorText(outcome: VerifyOutcomeDto): string | null {
  if (outcome === "ok") return null;
  if (outcome === "wrongCredentials") return "That password is not right.";
  if (outcome === "unknown") return "Something went wrong. Try again.";
  if (typeof outcome === "object" && "lockedOut" in outcome) {
    const seconds = Math.ceil(outcome.lockedOut.retryAfterMs / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `Too many tries. Try again in ${m}:${s.toString().padStart(2, "0")}.`;
  }
  return "Something went wrong. Try again.";
}

/**
 * Convenience lock. Apps stay open. Unlock checks the password with the agent.
 */
export function LockScreen({ shell, employee }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [logo, setLogo] = useState(true);
  const first = employee.name.split(" ")[0] ?? employee.name;
  useDocumentTitle("Locked - Rulebox");

  // The field is disabled while the password is checked, which drops the focus: put it back.
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!checking && message) {
      passwordRef.current?.focus();
    }
  }, [checking, message]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking || !password) return;
    setChecking(true);
    setMessage(null);
    try {
      const outcome = await call("unlock", { password });
      setPassword("");
      const text = errorText(outcome);
      if (text) setMessage(text);
    } catch {
      setPassword("");
      setMessage("Something went wrong. Try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <main
      data-testid="lock-screen"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--rb-bg)",
        color: "var(--rb-ink)",
      }}
    >
      <Backdrop />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 18,
        }}
      >
        <Panel
          size="md"
          style={{
            width: "100%",
            maxWidth: 360,
            padding: 28,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Avatar name={employee.name} size={48} decorative />
            <div>
              <h1 style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>{employee.name}</h1>
              <div style={{ marginTop: 2, fontSize: 13, color: "var(--rb-muted)" }}>
                Locked · your apps are still open
              </div>
            </div>
          </div>
          <form onSubmit={(event) => void submit(event)} style={{ display: "flex", gap: 8 }}>
            <Input
              ref={passwordRef}
              aria-label="Password"
              placeholder="Password"
              type="password"
              autoComplete="off"
              autoFocus
              value={password}
              disabled={checking}
              onChange={(event) => setPassword(event.target.value)}
              style={{ flex: 1 }}
            />
            <Button type="submit" icon disabled={checking || !password} aria-label="Unlock">
              {checking ? (
                <LogoMotion animation="loading" size={28} wordmark={false} tagline={null} />
              ) : (
                "→"
              )}
            </Button>
          </form>
          {message ? (
            <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--rb-danger-text)" }}>
              {message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void call("popup_open", { kind: "confirm", anchor: null })}
            style={{
              alignSelf: "flex-start",
              background: "none",
              border: 0,
              padding: 0,
              color: "var(--rb-accent-text)",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13.5,
            }}
          >
            Not {first}? Log out instead
          </button>
        </Panel>
        <div style={{ fontSize: 13, color: "var(--rb-muted)" }}>{shell.agent?.orgName ?? "Rulebox"}</div>
      </div>
      {logo ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 40,
            pointerEvents: "none",
          }}
        >
          <LogoMotion animation="lock" onDone={() => setLogo(false)} />
        </div>
      ) : null}
    </main>
  );
}
