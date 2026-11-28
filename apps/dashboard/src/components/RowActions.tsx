import { lazy, Suspense } from "react";
import { Button } from "@rulebox/ui";
import { strings } from "../lib/strings";
import type { RowAction } from "./DataTable";

export interface RowActionsProps {
  actions: readonly RowAction[];
  /** The record's name: the buttons say what they act on ("Revoke: VM run A3"). */
  rowName: string;
}

// The menu loads only for a row with more than two actions (see RowActionsMenu.tsx).
const MoreMenu = lazy(() => import("./RowActionsMenu").then((m) => ({ default: m.MoreMenu })));

/** Up to this many actions show as buttons; more go behind "More actions" (the `primary` one stays out). */
export const INLINE_ACTIONS = 2;

/**
 * A row's buttons, the same in the table's actions cell and in a card's footer. Two or fewer: small
 * buttons. More: the action marked `primary` (else the first) stays a button and the rest move into a
 * "More actions" menu, destructive items last. Confirm dialogs belong to the action, not to this.
 */
export function RowActions({ actions, rowName }: RowActionsProps) {
  if (actions.length === 0) return null;
  if (actions.length <= INLINE_ACTIONS) {
    return (
      <div className="dash-row-actions" data-no-row-click="true">
        {actions.map((a) => (
          <ActionButton key={a.label} action={a} rowName={rowName} />
        ))}
      </div>
    );
  }
  const at = Math.max(0, actions.findIndex((a) => a.primary));
  const primary = actions[at]!;
  const rest = actions.filter((_, i) => i !== at);
  // Stable: destructive items last, everything else in the given order.
  const menu = [...rest.filter((a) => !a.danger), ...rest.filter((a) => a.danger)];
  return (
    <div className="dash-row-actions" data-no-row-click="true">
      <ActionButton action={primary} rowName={rowName} />
      <Suspense fallback={<MoreMenuPlaceholder rowName={rowName} />}>
        <MoreMenu actions={menu} rowName={rowName} />
      </Suspense>
    </div>
  );
}

function ActionButton({ action, rowName }: { action: RowAction; rowName: string }) {
  return (
    <Button
      variant={action.danger ? "danger-ghost" : "ghost"}
      className="dash-btn--sm"
      disabled={action.disabled}
      title={action.disabled ? action.hint : undefined}
      aria-label={strings.table.actionFor(action.label, rowName)}
      onClick={action.onSelect}
    >
      {action.label}
    </Button>
  );
}

/** The button's place while the menu code loads: the same size, no icon, not clickable. */
function MoreMenuPlaceholder({ rowName }: { rowName: string }) {
  return <button type="button" className="dash-icon-btn dash-row-more" disabled aria-label={strings.table.moreActionsFor(rowName)} />;
}