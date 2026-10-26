import { useId, type ReactNode } from "react";

export interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** `flush`: the body has no side padding (tables, lists). */
  body?: "pad" | "flush" | "none";
  footer?: ReactNode;
  tone?: "danger";
  className?: string;
  /** The heading level inside the page (default h2). */
  level?: 2 | 3;
}

/** A labelled region of a screen. */
export function Card({ title, sub, actions, children, body = "pad", footer, tone, className, level = 2 }: CardProps) {
  const id = useId();
  const H = level === 2 ? "h2" : "h3";
  const cls = ["dash-card", tone === "danger" ? "dash-card--danger" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <section className={cls} aria-labelledby={title ? id : undefined}>
      {title || actions ? (
        <div className="dash-card__head">
          {title ? (
            <H id={id} className="dash-card__title">
              {title}
            </H>
          ) : null}
          {actions ? <div className="dash-card__actions">{actions}</div> : null}
          {sub ? <p className="dash-card__sub">{sub}</p> : null}
        </div>
      ) : null}
      {body === "none" ? children : <div className={body === "flush" ? "dash-card__body--flush" : "dash-card__body"}>{children}</div>}
      {footer ? <div className="dash-card__foot">{footer}</div> : null}
    </section>
  );
}
