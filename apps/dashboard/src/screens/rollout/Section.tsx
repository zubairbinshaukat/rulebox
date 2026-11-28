import { useId, type ReactNode } from "react";
import { InfoTip } from "@rulebox/ui";

/**
 * A card of the rollout page: the heading, an (i) tip next to it (the explanation that used to be a helper paragraph), an optional
 * right-hand slot (a count) and the body. Same look as the lockdown page's sections.
 */
export function RoSection({
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
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={["dash-card", "ro-sec", className ?? ""].filter(Boolean).join(" ")} aria-labelledby={id}>
      <div className="ro-sec__head">
        <h2 id={id} className="ro-sec__title">
          {title}
        </h2>
        {info ? <InfoTip label={infoLabel ?? `About ${title}`}>{info}</InfoTip> : null}
        {actions ? <div className="ro-sec__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
