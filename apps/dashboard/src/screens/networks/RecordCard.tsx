import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { InfoTip } from "@rulebox/ui";
import type { GroupOption } from "../../data/types";
import { networksStrings as n } from "./strings";

/** Group chips shown on a card; the rest is "+N" (the detail page lists them all). */
const CHIPS = 2;

/**
 * One Wi-Fi network, printer or driver as a card: icon tile, name, one muted line, a status pill and the groups it goes to. The whole card
 * is the link (the name's link is stretched over it), so there is no separate Edit button.
 */
export function RecordCard({
  to,
  icon,
  title,
  pill,
  sub,
  groups,
  groupCount,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  pill?: ReactNode;
  sub?: ReactNode;
  groups: GroupOption[];
  groupCount: number;
}) {
  const shown = groups.slice(0, CHIPS);
  return (
    <li className="net-rec">
      <span className="net-rec__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="net-rec__body">
        <div className="net-rec__top">
          <Link className="net-rec__link" to={to} title={title}>
            <span className="net-rec__name">{title}</span>
          </Link>
          {pill}
        </div>
        {sub ? <p className="net-rec__sub">{sub}</p> : null}
        <div className="net-rec__chips">
          {groupCount === 0 ? (
            <span className="net-rec__none">{n.notOnPcs}</span>
          ) : (
            <>
              {shown.map((g) => (
                <span key={g._id} className="dash-chip net-rec__chip" title={g.name}>
                  {g.name}
                </span>
              ))}
              {groupCount > shown.length ? <span className="net-rec__more">{n.moreChip(groupCount - shown.length)}</span> : null}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** A section of the page (Wi-Fi, Printers, Drivers): icon, title, count, (i) and a small Add; the records or one compact empty row below. */
export function SectionCard({
  name,
  icon,
  count,
  info,
  add,
  className,
  children,
}: {
  name: string;
  icon: ReactNode;
  count: number;
  info: string;
  /** The small Add in the head (admins, when there is something in the list). */
  add?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={["dash-card", "net-sec", "dash-enter", className ?? ""].filter(Boolean).join(" ")} aria-labelledby={id}>
      <header className="net-sec__head">
        <span className="net-sec__icon" aria-hidden="true">
          {icon}
        </span>
        <h2 id={id} className="net-sec__title">
          {name}
        </h2>
        <span className="net-sec__count">{n.count(count)}</span>
        <InfoTip label={n.aboutSection(name)}>{info}</InfoTip>
        <span className="net-sec__add">{add}</span>
      </header>
      <div className="net-sec__body">{children}</div>
    </section>
  );
}

/** The compact empty state: one dashed row with an icon, one line and (admins) the Add action. */
export function EmptyRow({ icon, text, sub, action }: { icon: ReactNode; text: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="net-empty">
      <span className="net-empty__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="net-empty__text">
        {text}
        {sub ? <span className="net-empty__sub"> {sub}</span> : null}
      </p>
      {action}
    </div>
  );
}
