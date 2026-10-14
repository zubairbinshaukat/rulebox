import { invoke } from "@tauri-apps/api/core";
import type {
  AgentLinkDto,
  EnrollmentDto,
  KioskPhaseDto,
  ShellState,
  ThemeDto,
} from "@rulebox/types";

/** What the shared popup window shows (Rust `shellwin::PopupKind`). */
export type PopupKind =
  | "start"
  | "quickSettings"
  | "account"
  | "switcher"
  | "thumb"
  | "confirm";

/** A control's rectangle in **physical** pixels, relative to its window. */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Externally-tagged serde shape of `SignInOutcome` (not in @rulebox/types yet —
 * do not run gen:types without asking).
 */
export type SignInOutcomeDto =
  | {
      ok: {
        employee: {
          id: string;
          username: string;
          name: string;
          role: string | null;
          quotaBytes: number;
        };
        filesRoot: string;
        offline: boolean;
      };
    }
  | "wrongCredentials"
  | "disabled"
  | { lockedOut: { retryAfterMs: number } }
  | "offlineNeverSignedIn"
  | "offlineExpired"
  | "unknown";

type Commands = {
  shell_state: { args: Record<string, never>; result: ShellState };
  ui_ready: { args: Record<string, never>; result: void };
  ui_alive: { args: Record<string, never>; result: void };
  dismiss_notice: { args: { id: number }; result: void };
  dev_set_display: { args: { lite: boolean; theme: ThemeDto }; result: void };
  dev_set_boot: {
    args: {
      link: AgentLinkDto | null;
      enrollment: EnrollmentDto | null;
      kioskPhase: KioskPhaseDto | null;
      clockSuspect: boolean | null;
    };
    result: void;
  };
  popup_open: {
    args: { kind: PopupKind; anchor: AnchorRect | null };
    result: void;
  };
  popup_close: { args: Record<string, never>; result: void };
  sign_in: {
    args: { username: string; password: string };
    result: SignInOutcomeDto;
  };
  sign_in_last: { args: { password: string }; result: SignInOutcomeDto };
  switch_user: { args: Record<string, never>; result: void };
  launch_app: { args: { id: string }; result: void };
  task_click: { args: { id: string }; result: void };
  task_close: { args: { id: string }; result: void };
  task_end: { args: { id: string }; result: void };
  task_menu: {
    args: { id: string | null; appId: string | null };
    result: void;
  };
  show_desktop: { args: Record<string, never>; result: void };
  refresh_catalogue: { args: Record<string, never>; result: void };
};

export function call<K extends keyof Commands>(
  name: K,
  args: Commands[K]["args"],
): Promise<Commands[K]["result"]> {
  return invoke(name, args) as Promise<Commands[K]["result"]>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The element's rectangle in physical pixels, for `popup_open`'s anchor. */
export function anchorOf(element: Element): AnchorRect {
  const box = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  return {
    x: box.left * ratio,
    y: box.top * ratio,
    width: box.width * ratio,
    height: box.height * ratio,
  };
}
