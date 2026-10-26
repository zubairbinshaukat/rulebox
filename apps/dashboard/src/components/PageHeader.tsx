import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import IconBack from "~icons/solar/alt-arrow-left-linear";
import { takeTitleFocus } from "../lib/focus";

export interface PageHeaderProps {
  title: ReactNode;
  lead?: ReactNode;
  /** Small row under the title (pills, status). */
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}

/** The one `<h1>` of a screen, with its lead sentence and primary actions. */
export function PageHeader({ title, lead, meta, actions, back }: PageHeaderProps) {
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeTitleFocus()) h1.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="dash-head">
      <div className="dash-head__text">
        {back ? (
          <Link to={back.to} className="dash-head__back">
            <IconBack aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}
        <h1 ref={h1} className="dash-head__title" tabIndex={-1} data-page-title>
          {title}
        </h1>
        {lead ? <p className="dash-head__lead">{lead}</p> : null}
        {meta ? <div className="dash-head__meta">{meta}</div> : null}
      </div>
      {actions ? <div className="dash-head__actions">{actions}</div> : null}
    </header>
  );
}
