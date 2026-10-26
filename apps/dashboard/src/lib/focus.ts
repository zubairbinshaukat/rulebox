/**
 * After a route change the new screen's `<h1>` takes focus, so keyboard and
 * screen-reader users start at the top of the new page. Not on first load.
 */
let pending = false;

export function requestTitleFocus() {
  pending = true;
}

export function takeTitleFocus(): boolean {
  const v = pending;
  pending = false;
  return v;
}
