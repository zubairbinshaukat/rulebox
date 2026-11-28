import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { MenuItem, MenuList, useFloating } from "@rulebox/ui";
import IconMore from "~icons/solar/menu-dots-linear";
import { strings } from "../lib/strings";
import type { RowAction } from "./DataTable";

/**
 * The "More actions" button and its menu. Its own module so a list with two or fewer actions per row
 * (and the whole table path before the first such row) never loads the menu, the floating placement or
 * the icon: `RowActions` loads this with `React.lazy` only for a row with more than two actions.
 */
export function MoreMenu({ actions, rowName }: { actions: readonly RowAction[]; rowName: string }) {
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
