import { invoke } from "@tauri-apps/api/core";

/**
 * The administrator-exit key listener, shared by every Rulebox page. It has no
 * dependency on the store or on React, so it still works when a page has
 * crashed. It also makes the exit reachable in dev mode, where no global
 * hotkey is registered. The combination comes from the backend (the agent's
 * setting); until it answers, the default is used.
 */

export const DEFAULT_COMBINATION = "Ctrl+Shift+F12";

export interface Combination {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-case: a letter, a digit, or `f1`..`f12`. */
  key: string;
}

/** Parses `Ctrl+Shift+F12`-style text. `null` for anything the agent would refuse. */
export function parseCombination(text: string): Combination | null {
  const parts = text.split("+").map((part) => part.trim().toLowerCase());
  const found = { ctrl: false, alt: false, shift: false };
  let key: string | null = null;
  for (const part of parts) {
    if (part === "ctrl" || part === "alt" || part === "shift") {
      if (found[part]) return null;
      found[part] = true;
    } else if (/^([a-z]|[0-9]|f([1-9]|1[0-2]))$/.test(part)) {
      if (key !== null) return null;
      key = part;
    } else {
      return null;
    }
  }
  if (key === null || (!found.ctrl && !found.alt)) {
    return null;
  }
  return { ...found, key };
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
}

/** Does this key event press exactly the combination? Extra modifiers do not match. */
export function matches(combination: Combination, event: KeyLike): boolean {
  if (event.metaKey) return false;
  if (event.ctrlKey !== combination.ctrl || event.altKey !== combination.alt || event.shiftKey !== combination.shift) {
    return false;
  }
  // With Alt or Shift held, `key` can be another character: the physical key (`code`) decides.
  const code = event.code ?? "";
  if (/^f\d+$/.test(combination.key)) {
    return event.key.toLowerCase() === combination.key || code.toLowerCase() === combination.key;
  }
  if (/^\d$/.test(combination.key)) {
    return event.key === combination.key || code === `Digit${combination.key}`;
  }
  return event.key.toLowerCase() === combination.key || code === `Key${combination.key.toUpperCase()}`;
}

let current: Combination | null = parseCombination(DEFAULT_COMBINATION);
let installed = false;

/** Listen for the combination in this page. Call once. */
export function installExitKey(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  // Ask which combination applies (it may have been changed from the dashboard).
  const refresh = () => {
    invoke<string | null>("admin_exit_hotkey")
      .then((text) => {
        // `null`: the organization turned the exit off, the key does nothing.
        current = text === null ? null : (parseCombination(text) ?? parseCombination(DEFAULT_COMBINATION));
      })
      .catch(() => {
        // Keep what we have: the default, or the last answer.
      });
  };
  refresh();
  window.addEventListener("focus", refresh);
  window.addEventListener(
    "keydown",
    (event) => {
      if (current && !event.repeat && matches(current, event)) {
        event.preventDefault();
        invoke("admin_exit_open").catch(() => undefined);
      }
    },
    true,
  );
}
