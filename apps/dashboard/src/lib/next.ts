/**
 * The `next` parameter after sign-in (Step 4 #3). Only same-site paths are
 * accepted: it must start with `/` and not `//` or `/\` (both are read by
 * browsers as another host). Anything else falls back to `/`.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  // Control characters and backslashes can confuse URL parsers.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(value)) return "/";
  return value;
}

/** Builds `/sign-in?next=…` (or another public path) for the current location. */
export function withNext(path: string, next: string): string {
  const safe = safeNext(next);
  return safe === "/" ? path : `${path}?next=${encodeURIComponent(safe)}`;
}
