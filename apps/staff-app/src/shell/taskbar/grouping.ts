import type { AppEntry, TaskItem } from "@rulebox/types";

/** One button on the taskbar. */
export type TaskbarButton =
  | {
      kind: "pinned";
      key: string;
      app: AppEntry;
      /** The app's open windows (maybe none: the app is only pinned). */
      tasks: TaskItem[];
    }
  | { kind: "task"; key: string; task: TaskItem };

/**
 * Pinned apps first, in catalogue order, each carrying every window that
 * belongs to it. Everything else (unpinned apps, programs the catalogue does
 * not know) gets one button per window, in the order the windows appeared.
 */
export function groupTaskbar(apps: AppEntry[], tasks: TaskItem[]): TaskbarButton[] {
  const pinned = apps.filter((app) => app.pinnedTaskbar);
  const pinnedIds = new Set(pinned.map((app) => app.id));

  const buttons: TaskbarButton[] = pinned.map((app) => ({
    kind: "pinned",
    key: `app:${app.id}`,
    app,
    tasks: tasks.filter((task) => task.appId === app.id),
  }));

  for (const task of tasks) {
    if (task.appId !== null && pinnedIds.has(task.appId)) {
      continue;
    }
    buttons.push({ kind: "task", key: `win:${task.id}`, task });
  }
  return buttons;
}

/**
 * The window a click on a button goes to: the only one; with several, the
 * one after the active window (wrapping), else the first. `null` when the
 * app has no window, which means "launch it".
 */
export function clickTarget(tasks: TaskItem[]): TaskItem | null {
  if (tasks.length === 0) {
    return null;
  }
  if (tasks.length === 1) {
    return tasks[0]!;
  }
  const active = tasks.findIndex((task) => task.active);
  return tasks[(active + 1) % tasks.length]!;
}

/** The state a button shows, summed over its windows. */
export interface ButtonState {
  open: boolean;
  active: boolean;
  minimized: boolean;
  flashing: boolean;
  hung: boolean;
  count: number;
}

export function stateOf(tasks: TaskItem[]): ButtonState {
  return {
    open: tasks.length > 0,
    active: tasks.some((t) => t.active),
    minimized: tasks.length > 0 && tasks.every((t) => t.minimized),
    flashing: tasks.some((t) => t.flashing),
    hung: tasks.some((t) => t.hung),
    count: tasks.length,
  };
}

/** Tooltip / accessible name of a button. */
export function labelOf(name: string, tasks: TaskItem[]): string {
  const state = stateOf(tasks);
  let label = name;
  if (tasks.length === 1) {
    const title = tasks[0]!.title.trim();
    if (title && title !== name) {
      label = `${name} — ${title}`;
    }
  } else if (tasks.length > 1) {
    label = `${name} (${tasks.length} windows)`;
  }
  if (state.hung) {
    label += " — Not responding";
  }
  return label;
}

/**
 * The accessible name of a task button: the label, plus what the open / minimized
 * / attention marks say (the bar under the icon shows them, but not to a screen
 * reader). "Active" is the pressed state (`aria-pressed`), so it is not repeated.
 */
export function stateLabel(label: string, state: ButtonState): string {
  const words: string[] = [];
  if (state.open) words.push(state.minimized ? "minimized" : "open");
  if (state.flashing) words.push("needs attention");
  return words.length > 0 ? `${label}, ${words.join(", ")}` : label;
}

/** `http://rbicon.localhost/<key>?s=<px>`: served by the Rust icon protocol. */
export function iconUrl(iconKey: string, px = 48): string {
  return `http://rbicon.localhost/${iconKey}?s=${px}`;
}
