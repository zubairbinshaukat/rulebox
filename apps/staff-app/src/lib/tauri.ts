import { invoke } from "@tauri-apps/api/core";
import type {
  AdminExitView,
  AgentLinkDto,
  Clip,
  ClipOp,
  CsvPreview,
  EnrollmentDto,
  Entry,
  ExitAnswer,
  FileKind,
  ImageInfo,
  KioskPhaseDto,
  OpenAction,
  PasteResult,
  ShellState,
  TextPreview,
  ThemeDto,
  TrashItem,
  Usage,
} from "@rulebox/types";

/** What the shared popup window shows (Rust `shellwin::PopupKind`). */
export type PopupKind =
  | "start"
  | "quickSettings"
  | "account"
  | "switcher"
  | "thumb"
  | "confirm"
  | "monitor";

/** A control's rectangle in **physical** pixels, relative to its window. */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a built-in window is showing. Mirrors Rust `appwin::AppView`. */
/** What the thumbnail preview is about (Rust `commands::ThumbInfo`). */
export interface ThumbInfo {
  taskId: string;
  title: string;
  iconKey: string;
  minimized: boolean;
}

export interface AppViewDto {
  label: string;
  lite: boolean;
  maximized: boolean;
  selected: number;
  tabs: { title: string; kind: string; path: string }[];
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

/** Externally-tagged serde shape of `VerifyOutcome`. */
export type VerifyOutcomeDto =
  | "ok"
  | "wrongCredentials"
  | { lockedOut: { retryAfterMs: number } }
  | "unknown";

type Commands = {
  shell_state: { args: Record<string, never>; result: ShellState };
  ui_ready: { args: Record<string, never>; result: void };
  ui_alive: { args: Record<string, never>; result: void };
  dismiss_notice: { args: { id: number }; result: void };
  notices_seen: { args: Record<string, never>; result: void };
  set_volume: { args: { level: number }; result: void };
  set_muted: { args: { muted: boolean }; result: void };
  set_brightness: { args: { level: number }; result: void };
  set_theme: { args: { theme: ThemeDto }; result: void };
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
  sign_out: { args: Record<string, never>; result: void };
  closing_apps: { args: Record<string, never>; result: string[] };
  lock: { args: Record<string, never>; result: void };
  unlock: { args: { password: string }; result: VerifyOutcomeDto };
  power_sleep: { args: Record<string, never>; result: void };
  power_restart: { args: Record<string, never>; result: void };
  power_shut_down: { args: Record<string, never>; result: void };
  restart_rulebox: { args: Record<string, never>; result: void };
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
  open_doc: { args: { kind: string; path: string }; result: string };
  win_minimize: { args: Record<string, never>; result: void };
  win_toggle_maximize: { args: Record<string, never>; result: void };
  win_close: { args: Record<string, never>; result: void };
  win_snap: { args: { zone: string }; result: void };
  app_snapshot: { args: Record<string, never>; result: AppViewDto };
  app_select_tab: { args: { index: number }; result: void };
  app_close_tab: { args: { index: number }; result: void };
  fs_list: { args: { path: string }; result: Entry[] };
  fs_stat: { args: { path: string }; result: Entry };
  fs_mkdir: { args: { path: string }; result: void };
  fs_rename: { args: { from: string; to: string }; result: void };
  fs_copy: { args: { from: string; toDir: string }; result: string };
  fs_move: { args: { from: string; toDir: string }; result: string };
  fs_trash: { args: { path: string; permanent: boolean }; result: void };
  fs_trash_list: { args: Record<string, never>; result: TrashItem[] };
  fs_restore: { args: { id: string }; result: string };
  fs_purge: { args: { id?: string | null }; result: void };
  fs_usage: { args: Record<string, never>; result: Usage };
  fs_search: { args: { query: string; searchId: number }; result: void };
  thumb_open: { args: { taskId: string; anchor: AnchorRect }; result: boolean };
  thumb_state: { args: Record<string, never>; result: ThumbInfo | null };
  thumb_attach: { args: { x: number; y: number; width: number; height: number }; result: boolean };
  admin_exit_open: { args: Record<string, never>; result: void };
  admin_exit_hotkey: { args: Record<string, never>; result: string | null };
  admin_exit_state: { args: Record<string, never>; result: AdminExitView };
  admin_exit_submit: { args: { pin: string }; result: ExitAnswer };
  admin_exit_close: { args: Record<string, never>; result: void };
  fs_recent: { args: Record<string, never>; result: Entry[] };
  fs_files: { args: { kind: FileKind; limit?: number }; result: Entry[] };
  fs_clip_set: { args: { op: ClipOp; paths: string[] }; result: void };
  fs_clip_get: { args: Record<string, never>; result: Clip | null };
  fs_paste: { args: { toDir: string }; result: PasteResult };
  fs_handler: { args: { path: string }; result: string | null };
  fs_read_text: { args: { path: string }; result: TextPreview };
  fs_read_csv: { args: { path: string }; result: CsvPreview };
  fs_office_check: { args: { path: string }; result: void };
  fs_image_info: { args: { path: string }; result: ImageInfo };
  fs_open: { args: { path: string }; result: OpenAction };
  fs_open_with: { args: { path: string }; result: OpenAction };
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
