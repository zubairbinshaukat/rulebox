import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LogoMotion } from "@rulebox/ui";
import type { EmployeeBrief, SessionState } from "@rulebox/types";

import { useMotionLevel } from "../lib/motion";
import { useShell } from "../lib/store";
import { call, isTauri } from "../lib/tauri";
import { Splash } from "./boot/Splash";
import { StatusScreen, type StatusKind } from "./boot/StatusScreen";
import { useLogoSequence } from "./boot/useLogoSequence";
import { Desktop } from "./desktop/Desktop";
import { LockScreen } from "./signin/LockScreen";
import { SignIn } from "./signin/SignIn";

function lastFromSession(session: SessionState): EmployeeBrief | null {
  if (session.status === "signedOut") {
    return session.last ?? null;
  }
  return null;
}

/**
 * Desktop window layers: splash → boot status / sign-in → open → desktop.
 */
export function DesktopRoot() {
  const shell = useShell((s) => s);
  const level = useMotionLevel();

  const [splashActive, setSplashActive] = useState(true);
  const [opening, setOpening] = useState(false);
  const [openFinished, setOpenFinished] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const waitStarted = useRef<number | null>(null);

  const splash = useLogoSequence("splash", level, splashActive);
  const openSeq = useLogoSequence("open", level, opening && !openFinished);

  // How long we've been waiting for the agent (timer callback only).
  useEffect(() => {
    if (shell.link === "linked" || shell.link === "versionMismatch") {
      waitStarted.current = null;
      return;
    }
    if (waitStarted.current == null) {
      waitStarted.current = Date.now();
    }
    const started = waitStarted.current;
    const id = window.setInterval(() => {
      if (Date.now() - started >= 20_000) {
        setUnavailable(true);
      }
    }, 1_000);
    return () => window.clearInterval(id);
  }, [shell.link]);

  // Clear unavailable when linked again (adjust during render).
  const linked = shell.link === "linked";
  const [wasLinked, setWasLinked] = useState(linked);
  if (linked !== wasLinked) {
    setWasLinked(linked);
    if (linked) {
      setUnavailable(false);
    }
  }

  const bootStatus: StatusKind | null = useMemo(() => {
    if (shell.link === "versionMismatch") return "needsUpdate";
    if (shell.link !== "linked") {
      return unavailable ? "unavailable" : "waiting";
    }
    const enrollment = shell.agent?.enrollment;
    if (enrollment === "notEnrolled") return "notSetUp";
    if (enrollment === "revoked") return "removed";
    if (shell.agent?.kioskPhase === "applying") return "applying";
    return null;
  }, [shell.link, shell.agent, unavailable]);

  // Skip splash once the next screen is known.
  useEffect(() => {
    if (!splashActive) return;
    if (bootStatus || shell.link === "linked") {
      splash.skip();
    }
  }, [splashActive, bootStatus, shell.link, splash]);

  // Leave splash when its sequence finishes.
  if (splashActive && splash.done) {
    setSplashActive(false);
  }

  // Finish open animation.
  if (opening && openSeq.done && !openFinished) {
    setOpenFinished(true);
    setOpening(false);
  }

  const signedIn =
    shell.session.status === "signedIn" && !shell.session.locked;

  const last = lastFromSession(shell.session);

  const dismissPopup = () => {
    if (isTauri()) {
      void call("popup_close", {});
    }
  };

  let body: ReactNode;
  if (splashActive) {
    body = <Splash seq={splash} />;
  } else if (bootStatus) {
    body = <StatusScreen kind={bootStatus} />;
  } else if (shell.session.status === "signingOut") {
    body = (
      <main
        data-testid="signing-out"
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--rb-bg)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <LogoMotion animation="lock" />
        <div role="status" style={{ fontSize: 15, color: "var(--rb-muted)" }}>
          Signing out…
        </div>
      </main>
    );
  } else if (shell.session.status === "signedIn" && shell.session.locked) {
    body = <LockScreen shell={shell} employee={shell.session.employee} />;
  } else if (signedIn && shell.session.status === "signedIn") {
    const showDesktop = openFinished || openSeq.covered || (!opening && !openFinished);
    body = (
      <div style={{ position: "absolute", inset: 0, background: "var(--rb-bg)" }}>
        {showDesktop ? <Desktop shell={shell} employee={shell.session.employee} /> : null}
        {opening && !openFinished ? (
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
            <LogoMotion
              key={openSeq.key}
              animation="open"
              onCovered={openSeq.onCovered}
              onDone={openSeq.onDone}
            />
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <SignIn
        shell={shell}
        last={last}
        onSuccess={() => {
          setOpenFinished(false);
          setOpening(true);
        }}
      />
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0 }} onPointerDown={dismissPopup}>
      {body}
    </div>
  );
}
