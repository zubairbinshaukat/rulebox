import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Avatar,
  Backdrop,
  Button,
  Input,
  LogoMotion,
  Panel,
} from "@rulebox/ui";
import type { EmployeeBrief, ShellState } from "@rulebox/types";

import { useDocumentTitle } from "../../lib/a11y";
import { call } from "../../lib/tauri";
import type { SignInOutcomeDto } from "../../lib/tauri";

type InlineError =
  | { kind: "wrong" }
  | { kind: "disabled" }
  | { kind: "locked"; until: number }
  | { kind: "offlineNever" }
  | { kind: "offlineExpired" }
  | { kind: "unsupported" }
  | { kind: "unknown" };

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * The current time for the sign-in screen. It moves once a minute, on the
 * minute (the screen shows no seconds), and once a second only while a lockout
 * countdown is on screen.
 */
function useClock(everySecond: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (everySecond) {
      // One reading right away, so a countdown that just started is not up to a minute stale.
      const kick = window.setTimeout(() => setNow(new Date()), 0);
      const id = window.setInterval(() => setNow(new Date()), 1_000);
      return () => {
        window.clearTimeout(kick);
        window.clearInterval(id);
      };
    }
    let timer = 0;
    const schedule = () => {
      const untilNextMinute = 60_000 - (Date.now() % 60_000) + 50;
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, untilNextMinute);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [everySecond]);
  return now;
}

function formatCountdown(until: number, now: number): string {
  const ms = Math.max(0, until - now);
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${pad(s)}`;
}

function outcomeToError(outcome: SignInOutcomeDto): InlineError | null {
  if (outcome === "wrongCredentials") return { kind: "wrong" };
  if (outcome === "disabled") return { kind: "disabled" };
  if (outcome === "offlineNeverSignedIn") return { kind: "offlineNever" };
  if (outcome === "offlineExpired") return { kind: "offlineExpired" };
  if (outcome === "unknown") return { kind: "unknown" };
  if (typeof outcome === "object" && outcome && "lockedOut" in outcome) {
    return { kind: "locked", until: Date.now() + outcome.lockedOut.retryAfterMs };
  }
  return null;
}

/**
 * The lockout message. The countdown is drawn second by second but hidden from
 * screen readers (the alert would repeat every second); they get whole minutes.
 */
function LockedText({ until, now }: { until: number; now: number }) {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return (
    <>
      Too many tries. Try again in <span aria-hidden="true">{formatCountdown(until, now)}</span>
      <span className="rb-sr-only">{minutes === 1 ? "about a minute" : `about ${minutes} minutes`}</span>.
    </>
  );
}

function errorText(error: InlineError, now: number): string {
  switch (error.kind) {
    case "wrong":
      return "That username or password is not right.";
    case "disabled":
      return "Your account has been turned off. Contact your administrator.";
    case "locked":
      return `Too many tries. Try again in ${formatCountdown(error.until, now)}.`;
    case "offlineNever":
      return "You need an internet connection the first time you sign in on this PC.";
    case "offlineExpired":
      return "Connect to the internet to sign in again.";
    case "unsupported":
      return "This PC's Rulebox agent cannot sign employees in yet.";
    case "unknown":
      return "Something went wrong. Try again.";
  }
}

export interface SignInProps {
  shell: ShellState;
  last: EmployeeBrief | null;
  onSuccess: (offline: boolean) => void;
}

export function SignIn({ shell, last, onSuccess }: SignInProps) {
  /** When true, show the username field even if a last employee exists. */
  const [switching, setSwitching] = useState(false);
  const returning = Boolean(last) && !switching;

  const [username, setUsername] = useState(last?.username ?? "");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [formError, setFormError] = useState<InlineError | null>(null);
  const [offlineNote, setOfflineNote] = useState(false);
  const now = useClock(formError?.kind === "locked");

  const canSession = shell.capabilities.includes("session");
  const reconnecting = shell.link !== "linked";
  const error: InlineError | null = !canSession
    ? { kind: "unsupported" }
    : formError;
  const locked = error?.kind === "locked" && error.until > now.getTime();
  const fieldsDisabled = checking || locked || reconnecting || !canSession;

  useDocumentTitle("Sign in - Rulebox");

  // The fields are disabled while the password is checked, which drops the keyboard focus.
  // After a wrong answer (or when a lockout ends) it goes back to the password field.
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (formError && !fieldsDisabled) {
      passwordRef.current?.focus();
    }
  }, [formError, fieldsDisabled]);

  // Keep username in sync when `last` identity changes (adjust during render).
  const lastKey = last ? `${last.username}:${last.name}` : "";
  const [prevLastKey, setPrevLastKey] = useState(lastKey);
  if (lastKey !== prevLastKey) {
    setPrevLastKey(lastKey);
    setSwitching(false);
    setUsername(last?.username ?? "");
  }

  const timeLabel = useMemo(
    () =>
      now.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    [now],
  );
  const dateLabel = useMemo(
    () =>
      now.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [now],
  );

  const org = shell.agent?.orgName ?? "Rulebox";
  const displayName = returning && last ? last.name : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (fieldsDisabled) return;
    setChecking(true);
    setFormError(null);
    setOfflineNote(false);
    try {
      const outcome = returning
        ? await call("sign_in_last", { password })
        : await call("sign_in", { username: username.trim(), password });
      setPassword("");
      if (typeof outcome === "object" && outcome && "ok" in outcome) {
        setOfflineNote(outcome.ok.offline);
        onSuccess(outcome.ok.offline);
        return;
      }
      setFormError(outcomeToError(outcome));
    } catch (err) {
      setPassword("");
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("unsupported")) {
        setFormError({ kind: "unsupported" });
      } else {
        setFormError({ kind: "unknown" });
      }
    } finally {
      setChecking(false);
    }
  }

  async function onSwitchUser() {
    await call("switch_user", {});
    setSwitching(true);
    setUsername("");
    setPassword("");
    setFormError(null);
  }

  const networkLabel =
    shell.system.network === "internet"
      ? "Online"
      : shell.system.network === "local"
        ? "Local network"
        : "Offline";

  return (
    <main
      data-testid="sign-in"
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
          padding: "48px 24px 72px",
          gap: 28,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 96,
              fontWeight: 500,
              letterSpacing: "-0.04em",
              lineHeight: 1,
            }}
          >
            {timeLabel}
          </div>
          <div style={{ marginTop: 8, fontSize: 18, color: "var(--rb-muted)" }}>
            {dateLabel}
          </div>
        </div>

        {shell.agent?.clockSuspect ? (
          <div
            role="status"
            style={{
              maxWidth: 360,
              width: "100%",
              padding: "10px 14px",
              borderRadius: 12,
              background: "var(--rb-warning-soft)",
              color: "var(--rb-warning-text)",
              fontSize: 13.5,
            }}
          >
            This PC&apos;s date and time look wrong. Tell your administrator.
          </div>
        ) : null}

        {reconnecting ? (
          <div
            role="status"
            style={{
              maxWidth: 360,
              width: "100%",
              padding: "10px 14px",
              borderRadius: 12,
              background: "var(--rb-accent-soft)",
              color: "var(--rb-accent-text)",
              fontSize: 13.5,
            }}
          >
            Rulebox is reconnecting…
          </div>
        ) : null}

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
          {displayName ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Avatar name={displayName} size={44} decorative />
              <div style={{ minWidth: 0 }}>
                <h1 style={{ margin: 0, fontWeight: 500, fontSize: 16 }}>{displayName}</h1>
                <button
                  type="button"
                  onClick={() => void onSwitchUser()}
                  style={{
                    marginTop: 2,
                    fontSize: 13,
                    color: "var(--rb-accent-text)",
                    background: "none",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  Not {displayName.split(" ")[0]}? Switch user
                </button>
              </div>
            </div>
          ) : (
            <h1 style={{ margin: 0, fontWeight: 500, fontSize: 16 }}>Sign in</h1>
          )}

          <form
            onSubmit={(e) => void submit(e)}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {!returning ? (
              <Input
                aria-label="Username"
                placeholder="Username"
                autoComplete="off"
                value={username}
                disabled={fieldsDisabled}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                ref={passwordRef}
                aria-label="Password"
                placeholder="Password"
                type="password"
                autoComplete="off"
                value={password}
                disabled={fieldsDisabled}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={returning}
                style={{ flex: 1 }}
              />
              <Button
                type="submit"
                icon
                disabled={
                  fieldsDisabled || (!returning && !username.trim()) || !password
                }
                aria-label={checking ? "Signing in" : "Sign in"}
              >
                {checking ? (
                  <LogoMotion animation="loading" size={28} wordmark={false} tagline={null} />
                ) : (
                  "→"
                )}
              </Button>
            </div>
          </form>

          {error ? (
            <p
              data-testid="sign-in-error"
              role="alert"
              style={{ margin: 0, fontSize: 13.5, color: "var(--rb-danger-text)" }}
            >
              {error.kind === "locked" ? (
                <LockedText until={error.until} now={now.getTime()} />
              ) : (
                errorText(error, now.getTime())
              )}
            </p>
          ) : null}

          {offlineNote ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--rb-muted)" }}>
              Offline — signed in with saved details.
            </p>
          ) : null}
        </Panel>
      </div>

      <div
        style={{
          position: "absolute",
          left: 24,
          bottom: 20,
          zIndex: 2,
          fontSize: 13,
          color: "var(--rb-muted)",
        }}
      >
        {org}
      </div>
      <div
        style={{
          position: "absolute",
          right: 24,
          bottom: 20,
          zIndex: 2,
          fontSize: 13,
          color: "var(--rb-muted)",
          display: "flex",
          gap: 12,
        }}
      >
        <span>{networkLabel}</span>
        {shell.system.battery?.percent != null ? (
          <span>
            {shell.system.battery.charging ? "Charging " : ""}
            {shell.system.battery.percent}%
          </span>
        ) : null}
      </div>
    </main>
  );
}
