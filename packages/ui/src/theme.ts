export type Theme = "light" | "dark" | "auto";

/** Sets the theme on <html>. "auto" follows prefers-color-scheme. */
export function setTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "light") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** Lite mode (PRD 22.5): no blur/glass, no blobs, no transitions. */
export function setLite(lite: boolean, root: HTMLElement = document.documentElement): void {
  if (lite) root.setAttribute("data-lite", "true");
  else root.removeAttribute("data-lite");
}