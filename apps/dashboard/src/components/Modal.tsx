import type { FormEvent, ReactNode } from "react";
import { Dialog } from "@rulebox/ui";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  /** Wraps body + actions in a <form>: Enter submits. */
  onSubmit?: () => void;
  className?: string;
}

/**
 * The packages/ui `Dialog` (focus trap, Escape, focus restore) with the
 * dashboard's look: a bottom sheet below 640 px, and a CSS entrance on open
 * (`.dash-dialog` in dashboard.css: transform + opacity only, fade only with
 * reduced motion or Lite).
 */
export function Modal({ open, title, onClose, children, actions, wide, onSubmit, className }: ModalProps) {
  if (!open) return null;

  const cls = ["dash-dialog", wide ? "dash-dialog--wide" : "", className ?? ""].filter(Boolean).join(" ");
  const content = onSubmit ? (
    <form
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      {actions ? <div className="rb-dialog__actions">{actions}</div> : null}
    </form>
  ) : (
    <>
      {children}
      {actions ? <div className="rb-dialog__actions">{actions}</div> : null}
    </>
  );

  return (
    <Dialog open title={title} onClose={onClose} className={cls}>
      {content}
    </Dialog>
  );
}
