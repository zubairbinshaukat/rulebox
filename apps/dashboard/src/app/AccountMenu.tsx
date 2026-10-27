import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Avatar, MenuItem, MenuList, Pill, SegmentedControl, type Theme } from "@rulebox/ui";
import IconLogout from "~icons/solar/logout-2-linear";
import IconShield from "~icons/solar/shield-check-linear";
import IconDown from "~icons/solar/alt-arrow-down-linear";
import { useAuthActions } from "../data";
import { useMember } from "../lib/member";
import { strings } from "../lib/strings";
import { useTheme } from "./theme";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import { secShell } from "../lib/stepup/strings-shell";
import { useStepUpController } from "../stepup/context";

const THEMES = [
  { value: "light", label: strings.app.themeLight },
  { value: "dark", label: strings.app.themeDark },
  { value: "auto", label: strings.app.themeAuto },
] as const;

/** Email, role, theme and Sign out (Step 4 #4). A disclosure, closed by Escape or a click outside. */
export function AccountMenu() {
  const me = useMember();
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const stepUp = useStepUpController();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const localPart = me.email.split("@")[0] ?? me.email;

  return (
    <div className="dash-popover" ref={root}>
      <button
        ref={button}
        type="button"
        className="dash-account-btn"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true" style={{ display: "inline-flex" }}><Avatar name={localPart.replace(/[._-]+/g, " ")} size={32} /></span>
        <span className="dash-sr">{strings.app.accountMenuLabel}</span>
        <span className="dash-account-btn__email">{me.email}</span>
        <IconDown className="dash-account-btn__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="dash-popover__panel" id={panelId}>
          <div className="dash-popover__head">
            <span aria-hidden="true" style={{ display: "inline-flex" }}><Avatar name={localPart.replace(/[._-]+/g, " ")} size={40} /></span>
            <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="dash-muted" style={{ fontSize: 12.5 }}>
                {strings.app.signedInAs}
              </span>
              <span className="dash-popover__email">{me.email}</span>
              <span>
                <Pill tone="accent">{strings.app.roles[me.role]}</Pill>
              </span>
            </div>
          </div>
          <div className="dash-popover__section">
            <p className="dash-overline" style={{ marginBottom: 8 }} id={`${panelId}-theme`}>
              {strings.app.theme}
            </p>
            <SegmentedControl<Theme> options={THEMES} value={theme} onChange={setTheme} aria-label={strings.app.theme} />
          </div>
          <MenuList aria-label={strings.app.accountMenu(me.email)}>
            <MenuItem
              icon={<IconShield />}
              onSelect={() => {
                setOpen(false);
                navigate("/mfa");
              }}
            >
              {strings.app.security}
            </MenuItem>
            {stepUp ? (
              <MenuItem
                icon={<IconLock />}
                onSelect={() => {
                  setOpen(false);
                  stepUp.lockNow("manual");
                }}
              >
                {secShell.lockNow}
              </MenuItem>
            ) : null}
            <MenuItem
              danger
              icon={<IconLogout />}
              onSelect={() => {
                setOpen(false);
                void signOut().then(() => navigate("/sign-in", { replace: true }));
              }}
            >
              {strings.app.signOut}
            </MenuItem>
          </MenuList>
        </div>
      ) : null}
    </div>
  );
}
