import { useRef, type FormEvent, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import { Dialog } from "@rulebox/ui";
import { enter, useMotionLevel } from "../lib/motion";

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
 * dashboard's look: a bottom sheet below 640 px, and a GSAP entrance
 * (transform + opacity only; fade only with reduced motion).
 */
export function Modal({ open, title, onClose, children, actions, wide, onSubmit, className }: ModalProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const level = useMotionLevel();

  useGSAP(
    () => {
      if (!open) return;
      const panel = wrap.current?.querySelector(".rb-dialog");
      const backdrop = wrap.current?.querySelector(".rb-dialog-backdrop");
      if (backdrop) enter(backdrop, "fade", { duration: 0.15 });
      if (panel) enter(panel, level, { y: 0, duration: 0.2 });
    },
    { scope: wrap, dependencies: [open, level] },
  );

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
    <div ref={wrap} style={{ display: "contents" }}>
      <Dialog open title={title} onClose={onClose} className={cls}>
        {content}
      </Dialog>
    </div>
  );
}
