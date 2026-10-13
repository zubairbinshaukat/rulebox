import { invoke } from "@tauri-apps/api/core";
import type { ShellState, ThemeDto } from "@rulebox/types";

type Commands = {
  shell_state: { args: Record<string, never>; result: ShellState };
  ui_ready: { args: Record<string, never>; result: void };
  ui_alive: { args: Record<string, never>; result: void };
  dismiss_notice: { args: { id: number }; result: void };
  dev_set_display: { args: { lite: boolean; theme: ThemeDto }; result: void };
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
