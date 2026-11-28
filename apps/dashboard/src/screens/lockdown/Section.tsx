import { useId, type ReactNode } from "react";
import { InfoTip } from "@rulebox/ui";

/**
 * A card of the lockdown page: the heading, an (i) tip next to it (the explanation that used to be a helper paragraph) and the body.
 * `children` may be a function that gets the heading's id (a radio group is named by it).
 */
export function LkSection({
  title,
  info,
  infoLabel,
  actions,
  className,
  children,
}: {
  title: string;
  info?: ReactNode;
  /** The (i) button's name; default "About {title}". */
  infoLabel?: string;
  /** Right of the heading (a count, a pill). */
  actions?: ReactNode;
  className?: string;
  children: ReactNode | ((headingId: string) => ReactNode);
}) {
  const id = useId();
  return (
    <section className={["dash-card", "lk-sec", className ?? ""].filter(Boolean).join(" ")} aria-labelledby={id}>
      <div className="lk-sec__head">
        <h2 id={id} className="lk-sec__title">
          {title}
        </h2>
        {info ? <InfoTip label={infoLabel ?? `About ${title}`}>{info}</InfoTip> : null}
        {actions ? <div className="lk-sec__actions">{actions}</div> : null}
      </div>
      {typeof children === "function" ? children(id) : children}
    </section>
  );
}
