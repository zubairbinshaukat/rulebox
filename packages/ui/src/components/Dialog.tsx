import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

export interface DialogProps {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  open?: boolean;
  onClose?: () => void;
  className?: string;
  /** `alertdialog` for a question that needs an answer (confirm a delete). */
  role?: "dialog" | "alertdialog";
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Skips what cannot take focus (hidden, `inert`); `offsetParent` is no use, it is null for fixed elements and in test DOMs. */
function isFocusable(el: HTMLElement): boolean {
  if (el.hidden || el.closest("[hidden], [inert]")) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : true;
}

/** Modal dialog with focus trap and Escape to close. */
export function Dialog({ title, children, actions, open = true, onClose, className, role = "dialog" }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const root = dialogRef.current;
    if (!root) return;

    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
    const first = focusables[0];
    (first ?? root).focus();

    return () => {
      // Back to what opened the dialog (if it is still on the page).
      const opener = previouslyFocused.current;
      if (opener?.isConnected) opener.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;

    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
    if (focusables.length === 0) {
      e.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onBackdropClick(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose?.();
  }

  const cls = ["rb-dialog", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className="rb-dialog-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        className={cls}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="rb-dialog__title">
          {title}
        </h2>
        <div id={bodyId} className="rb-dialog__body">
          {children}
        </div>
        {actions ? <div className="rb-dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
