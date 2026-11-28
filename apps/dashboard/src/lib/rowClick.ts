import type { MouseEvent } from "react";

/** Elements inside a row or card that own their click: the row's click must not fire for them. */
const OWN_CLICK =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="dialog"], [role="alertdialog"], .rb-dialog-backdrop, [contenteditable="true"], [data-no-row-click]';

/**
 * True when a click on a table row or a card must NOT open the record: it hit a link, button or field
 * inside (or a `data-no-row-click` element), it was a modified or non-primary click, it came from a
 * portalled dialog or menu, or the person is selecting text.
 */
export function ignoreRowClick(e: MouseEvent<HTMLElement>): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;
  // A dialog opened from a cell is portalled to <body>: React still bubbles its clicks here, but it is not in the row.
  if (!e.currentTarget.contains(e.target as Node)) return true;
  const hit = (e.target as Element).closest(OWN_CLICK);
  if (hit && e.currentTarget.contains(hit)) return true;
  // The person is selecting text in the row: not a click on the row.
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}
