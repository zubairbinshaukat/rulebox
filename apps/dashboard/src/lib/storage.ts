/**
 * Storage that never throws: private windows, blocked site data and quota
 * errors all fall back to "nothing stored". Used only for per-browser
 * conveniences (theme, demo session); nothing here must be relied on.
 */
type Kind = "local" | "session";

function store(kind: Kind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorage(key: string, kind: Kind = "local"): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null, kind: Kind = "local"): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // ignore: storage is a convenience only
  }
}
