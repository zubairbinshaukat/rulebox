import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, MenuItem, MenuList, useFloating } from "@rulebox/ui";
import IconMore from "~icons/solar/menu-dots-linear";
import { strings } from "../lib/strings";
import type { RowAction } from "./DataTable";

export interface RowActionsProps {
  actions: readonly RowAction[];
  /** The record's name: the buttons say what they act on ("Revoke: VM run A3"). */
  rowName: string;
}

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
      <MoreMenu actions={menu} rowName={rowName} />
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

function MoreMenu({ actions, rowName }: { actions: readonly RowAction[]; rowName: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useFloating(open, triggerRef, popupRef, { side: "bottom", align: "end", gap: 6 });

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus goes into the menu on open.
  useLayoutEffect(() => {
    if (open) popupRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  // A click outside closes it without taking the focus back.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (popupRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  function onMenuKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      // The Escape that closes the menu must not also close a dialog around it.
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(true);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="dash-icon-btn dash-row-more"
        aria-label={strings.table.moreActionsFor(rowName)}
        title={strings.table.moreActions}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconMore aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div ref={popupRef} className="dash-row-menu" onKeyDown={onMenuKeyDown}>
              <MenuList id={menuId} aria-label={strings.table.moreActionsFor(rowName)}>
                {actions.map((a) => (
                  <MenuItem
                    key={a.label}
                    danger={a.danger}
                    disabled={a.disabled}
                    hint={a.disabled ? a.hint : undefined}
                    onSelect={() => {
                      close(true);
                      a.onSelect();
                    }}
                  >
                    {a.label}
                  </MenuItem>
                ))}
              </MenuList>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
