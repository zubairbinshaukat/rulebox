export interface KeyData {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  isEditing?: boolean;
  isDialog?: boolean;
  isMenu?: boolean;
}

export type ExplorerKeyAction =
  | { type: "nav-arrow"; direction: "up" | "down" | "left" | "right"; extend: boolean }
  | { type: "nav-home"; extend: boolean }
  | { type: "nav-end"; extend: boolean }
  | { type: "nav-page-up"; extend: boolean }
  | { type: "nav-page-down"; extend: boolean }
  | { type: "select-all" }
  | { type: "open" }
  | { type: "rename" }
  | { type: "delete"; permanent: boolean }
  | { type: "copy" }
  | { type: "cut" }
  | { type: "paste" }
  | { type: "parent" }
  | { type: "history-back" }
  | { type: "history-forward" }
  | { type: "refresh" }
  | { type: "search" }
  | { type: "new-folder" }
  | { type: "context-menu" }
  | { type: "cancel" }
  | { type: "type-ahead"; char: string }
  | null;

/** Pure function resolving an Explorer keyboard event to an action. */
export function resolveKeyAction(
  event: KeyData,
  context: KeyContext = {},
): ExplorerKeyAction {
  const ctrlOrMeta = event.ctrlKey || event.metaKey;

  if (context.isEditing) {
    if (event.key === "Escape") {
      return { type: "cancel" };
    }
    // Enter is the rename field's own submit; it must never open the file.
    return null;
  }

  if (context.isDialog || context.isMenu) {
    if (event.key === "Escape") {
      return { type: "cancel" };
    }
    return null;
  }

  // Ctrl+Shift+N: New folder
  if (ctrlOrMeta && event.shiftKey && (event.key === "N" || event.key === "n")) {
    return { type: "new-folder" };
  }

  // Ctrl combinations
  if (ctrlOrMeta && !event.altKey) {
    switch (event.key.toLowerCase()) {
      case "a":
        return { type: "select-all" };
      case "c":
        return { type: "copy" };
      case "x":
        return { type: "cut" };
      case "v":
        return { type: "paste" };
      case "f":
        return { type: "search" };
    }
  }

  // Alt navigation
  if (event.altKey && !ctrlOrMeta) {
    if (event.key === "ArrowUp") {
      return { type: "parent" };
    }
    if (event.key === "ArrowLeft") {
      return { type: "history-back" };
    }
    if (event.key === "ArrowRight") {
      return { type: "history-forward" };
    }
  }

  // Function keys
  if (event.key === "F2") {
    return { type: "rename" };
  }
  if (event.key === "F5") {
    return { type: "refresh" };
  }
  if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
    return { type: "context-menu" };
  }

  // Backspace: Parent
  if (event.key === "Backspace" && !ctrlOrMeta && !event.altKey) {
    return { type: "parent" };
  }

  // Delete / Shift+Delete
  if (event.key === "Delete") {
    return { type: "delete", permanent: event.shiftKey };
  }

  // Enter: Open
  if (event.key === "Enter") {
    return { type: "open" };
  }

  // Escape: Cancel / clear
  if (event.key === "Escape") {
    return { type: "cancel" };
  }

  // Navigation arrows
  switch (event.key) {
    case "ArrowUp":
      return { type: "nav-arrow", direction: "up", extend: event.shiftKey };
    case "ArrowDown":
      return { type: "nav-arrow", direction: "down", extend: event.shiftKey };
    case "ArrowLeft":
      return { type: "nav-arrow", direction: "left", extend: event.shiftKey };
    case "ArrowRight":
      return { type: "nav-arrow", direction: "right", extend: event.shiftKey };
    case "Home":
      return { type: "nav-home", extend: event.shiftKey };
    case "End":
      return { type: "nav-end", extend: event.shiftKey };
    case "PageUp":
      return { type: "nav-page-up", extend: event.shiftKey };
    case "PageDown":
      return { type: "nav-page-down", extend: event.shiftKey };
  }

  // Type-ahead: single printable character without Ctrl/Alt
  if (
    event.key.length === 1 &&
    !ctrlOrMeta &&
    !event.altKey &&
    !event.key.match(/[\t\r\n]/)
  ) {
    return { type: "type-ahead", char: event.key };
  }

  return null;
}

/** 500 ms buffer for type-ahead navigation. */
export class TypeAheadBuffer {
  private buffer = "";
  private lastTime = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 500) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Pushes a character and returns the matched path, or null if no match.
   */
  public push(
    char: string,
    items: { name: string; path: string }[],
    now = Date.now(),
  ): string | null {
    if (now - this.lastTime > this.timeoutMs) {
      this.buffer = char;
    } else {
      this.buffer += char;
    }
    this.lastTime = now;

    const lower = this.buffer.toLowerCase();
    const found = items.find((item) =>
      item.name.toLowerCase().startsWith(lower),
    );
    return found ? found.path : null;
  }

  public clear(): void {
    this.buffer = "";
    this.lastTime = 0;
  }

  public getBuffer(): string {
    return this.buffer;
  }
}
