import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { MenuItem, MenuList, useFloating, type FloatingAlign } from "@rulebox/ui";
import IconMore from "~icons/solar/menu-dots-linear";
import "./MoreMenu.css";

interface MoreMenuItemBase {
  label: string;
  icon?: ReactNode;
  /** Danger items are drawn in the danger colour and always sit last, after a divider. */
  danger?: boolean;
  /** Left out of the menu (a role check): the caller does not filter its own list. */
  hidden?: boolean;
  disabled?: boolean;
}
/** An item either runs something or goes to a page (`to`, an app path: navigated with the router). */
export type MoreMenuItem = MoreMenuItemBase & ({ onSelect: () => void; to?: never } | { to: string; onSelect?: never });

export interface MoreMenuProps {
  items: readonly MoreMenuItem[];
  /** The accessible name and tooltip of the button. Default "More". */
  label?: string;
  /** Which edge of the button the menu lines up with. Default `end` (the button sits at the right of a header). */
  align?: FloatingAlign;
  /** The button's content. Default: three dots. */
  children?: ReactNode;
  className?: string;
}

/**
 * The "..." button of a page header and its menu: secondary and rare actions (Rename, Staged rollout, Delete). A menu button:
 * `aria-haspopup="menu"`, Enter / Space / Arrow Down open it and move into it, the arrows, Home and End move between items,
 * Esc closes it and gives the focus back to the button, Tab closes it. It is placed by `placeFloating`, so it flips up and
 * stays on screen. With no visible item it draws nothing.
 */
export function MoreMenu({ items, label = "More", align = "end", children, className }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const navigate = useNavigate();
  useFloating(open, triggerRef, popupRef, { side: "bottom", align, gap: 6 });

  // Plain actions first, danger last (after a divider); the order the caller gave is kept inside each group.
  const [normal, danger] = useMemo(() => {
    const visible = items.filter((i) => !i.hidden);
    return [visible.filter((i) => !i.danger), visible.filter((i) => i.danger)] as const;
  }, [items]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  // The focus goes into the menu on open (the last item when it was opened upwards with Arrow Up).
  const entry = useRef<"first" | "last">("first");
  useLayoutEffect(() => {
    if (!open) return;
    const all = popupRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
    if (all && all.length > 0) (entry.current === "last" ? all[all.length - 1]! : all[0]!).focus({ preventScroll: true });
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

  // A menu that loses all its items while open (a role change) closes.
  if (open && normal.length + danger.length === 0) setOpen(false);
  if (normal.length + danger.length === 0) return null;

  function onMenuKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      // The Escape that closes the menu must not also close a dialog or a sheet around it.
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(true);
    }
  }

  function choose(item: MoreMenuItem) {
    close(true);
    if (item.to !== undefined) navigate(item.to);
    else item.onSelect();
  }

  const entries = (list: readonly MoreMenuItem[]) =>
    list.map((i) => (
      <MenuItem key={i.label} danger={i.danger} disabled={i.disabled} icon={i.icon} onSelect={() => choose(i)}>
        {i.label}
      </MenuItem>
    ));

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={["dash-icon-btn", "dash-more", className ?? ""].filter(Boolean).join(" ")}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          entry.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            entry.current = e.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        }}
      >
        {children ?? <IconMore aria-hidden="true" />}
      </button>
      {open
        ? createPortal(
            <div ref={popupRef} className="dash-more__menu" onKeyDown={onMenuKeyDown}>
              <MenuList id={menuId} aria-label={label}>
                {entries(normal)}
                {normal.length > 0 && danger.length > 0 ? <div className="dash-more__sep" role="separator" /> : null}
                {entries(danger)}
              </MenuList>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
