import { Children, type ReactNode } from "react";
import { Link } from "react-router";
import { InfoTip } from "@rulebox/ui";
import IconArrow from "~icons/solar/alt-arrow-right-linear";
import "./StatTile.css";

export type StatTileTone = "ok" | "warning" | "danger";

interface StatTileBase {
  label: string;
  /** The number or word that matters ("523", "Trial run"). */
  value: ReactNode;
  /** A little more, in the same row when it fits ("498 online"). */
  sub?: ReactNode;
  /** A Solar icon element, drawn small in a tinted square. */
  icon?: ReactNode;
  /** `ok` green, `warning` amber, `danger` red. Neutral by default. The sub line should say it in words too. */
  tone?: StatTileTone;
  /** Delay the entrance by this many steps (tiles of one row come in one after the other). */
  index?: number;
  className?: string;
}
/** A tile is a link (`to`), a button (`onClick`), or just a number with an optional (i) tip (`info`). The tip and the link do not mix: a tip is a button of its own. */
export type StatTileProps = StatTileBase &
  ({ to: string; onClick?: never; info?: never } | { onClick: () => void; to?: never; info?: never } | { to?: never; onClick?: never; info?: ReactNode });

/**
 * A compact number tile (about 72 px high) for the top of a page: PCs, People, Apps, Protection. Looks like the device
 * page's tiles. It reads aloud as "label value sub", and a tile that goes somewhere is one link or button with a chevron.
 */
export function StatTile({ label, value, sub, icon, tone, index = 0, className, to, onClick, info }: StatTileProps) {
  const body = (
    <>
      {icon ? (
        <span className="dash-tile__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="dash-tile__text">
        <span className="dash-tile__label">{label}</span>{" "}
        <span className="dash-tile__line">
          <span className="dash-tile__value">{value}</span>
          {sub ? " " : null}
          {sub ? <span className="dash-tile__sub">{sub}</span> : null}
        </span>
      </span>
    </>
  );
  const root = ["dash-tile", "dash-enter", className ?? ""].filter(Boolean).join(" ");
  const style = { animationDelay: `${Math.min(index, 8) * 25}ms` };
  if (to !== undefined) {
    return (
      <Link className={`${root} dash-tile--link`} data-tone={tone} style={style} to={to}>
        {body}
        <span className="dash-tile__go" aria-hidden="true">
          <IconArrow />
        </span>
      </Link>
    );
  }
  if (onClick !== undefined) {
    return (
      <button type="button" className={`${root} dash-tile--link`} data-tone={tone} style={style} onClick={onClick}>
        {body}
        <span className="dash-tile__go" aria-hidden="true">
          <IconArrow />
        </span>
      </button>
    );
  }
  return (
    <div className={root} data-tone={tone} style={style}>
      {body}
      {info ? (
        <span className="dash-tile__tip">
          <InfoTip label={`About ${label}`}>{info}</InfoTip>
        </span>
      ) : null}
    </div>
  );
}

/** The row of tiles: two across on a phone, as many as fit from there (about 170 px each). */
export function StatTiles({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul className={["dash-tiles", className ?? ""].filter(Boolean).join(" ")} aria-label={label}>
      {Children.toArray(children).map((child, i) => (
        <li key={i} className="dash-tiles__item">
          {child}
        </li>
      ))}
    </ul>
  );
}
