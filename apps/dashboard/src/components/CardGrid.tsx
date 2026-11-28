import { memo, useId, useMemo, type ReactNode } from "react";
import { cardLayout, columnType, type CardLayout } from "../lib/cardLayout";
import { ignoreRowClick } from "../lib/rowClick";
import { strings } from "../lib/strings";
import type { Column } from "./DataTable";
import { RowActions } from "./RowActions";
import { Truncate } from "./Truncate";

export interface CardGridProps<T> {
  /** Names the list for screen readers (the table's caption). */
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  /** Muted cards (disabled employees, revoked codes): text in the muted colour, the status pill says why. */
  isDim?: (row: T) => boolean;
  /** Makes the whole card clickable (same handler as table rows). The title link stays the real link. */
  onActivate?: (row: T) => void;
  /** The record's name, for the buttons' names ("Revoke: VM run A3"). Required with `rowActions`. */
  rowLabel?: (row: T) => string;
  /** The next page is loading: the old cards stay, dimmed, and the list is announced as busy. */
  busy?: boolean;
  /** A list inside a `Card`: flat tiles (border, no shadow). */
  flat?: boolean;
}

/**
 * The Cards view of a list: one `RecordCard` per row, built from the same `Column` definitions as the
 * table (roles in `lib/cardLayout.ts`, the anatomy in `lists-and-cards.md` section 3). The grid's columns
 * come from the list's own width (a container query in dashboard.css), never from the viewport.
 */
export function CardGrid<T>({ caption, columns, rows, getKey, isDim, onActivate, rowLabel, busy = false, flat = false }: CardGridProps<T>) {
  const layout = useMemo(() => cardLayout(columns), [columns]);
  return (
    <ul className="dash-cards" role="list" aria-label={caption} aria-busy={busy || undefined} data-busy={busy || undefined} data-flat={flat || undefined}>
      {rows.map((row) => (
        <RecordCard
          key={getKey(row)}
          row={row}
          layout={layout as CardLayout<unknown>}
          dim={isDim?.(row) ?? false}
          onActivate={onActivate as ((row: unknown) => void) | undefined}
          rowLabel={rowLabel as ((row: unknown) => string) | undefined}
        />
      ))}
    </ul>
  );
}

const present = (n: ReactNode): boolean => n !== null && n !== undefined && n !== false && n !== "";

function labelOf(c: Column<unknown>): string | null {
  return c.cardLabel === false ? null : (c.cardLabel ?? c.header);
}

const RecordCard = memo(function RecordCard({
  row,
  layout,
  dim,
  onActivate,
  rowLabel,
}: {
  row: unknown;
  layout: CardLayout<unknown>;
  dim: boolean;
  onActivate?: (row: unknown) => void;
  rowLabel?: (row: unknown) => string;
}) {
  const titleId = useId();
  const { title, subtitle, status, facts, details, actions } = layout;

  const sub = subtitle && !subtitle.isEmpty?.(row) ? subtitle.render(row) : null;
  const badges = status.filter((c) => !c.isEmpty?.(row)).map((c) => ({ key: c.key, node: (c.cardCell ?? c.cell)(row) }));
  const shownDetails = details.filter((c) => !c.isEmpty?.(row));
  const inline = shownDetails.filter((c) => columnType(c) !== "text");
  const blocks = shownDetails.filter((c) => columnType(c) === "text");
  const hasDetails = inline.length > 0 || blocks.length > 0;

  let actionsNode: ReactNode = null;
  if (actions && !actions.isEmpty?.(row)) {
    if (actions.rowActions) {
      const list = actions.rowActions(row);
      actionsNode = list.length > 0 ? <RowActions actions={list} rowName={rowLabel?.(row) ?? ""} /> : null;
    } else {
      const node = (actions.cardCell ?? actions.cell)(row);
      actionsNode = present(node) ? <div className="dash-row-actions" data-no-row-click="true">{node}</div> : null;
    }
  }

  return (
    <li className="dash-cards__item">
      <article
        className="dash-rcard"
        aria-labelledby={titleId}
        data-dim={dim || undefined}
        data-clickable={onActivate ? true : undefined}
        onClick={
          onActivate
            ? (e) => {
                if (!ignoreRowClick(e)) onActivate(row);
              }
            : undefined
        }
      >
        <div className="dash-rcard__title" id={titleId}>
          <Truncate lines={2}>{(title.cardCell ?? title.cell)(row)}</Truncate>
        </div>
        {present(sub) ? (
          <div className="dash-rcard__sub">
            <Truncate lines={1}>{sub}</Truncate>
          </div>
        ) : null}
        {badges.length > 0 ? (
          <div className="dash-rcard__status">
            {badges.map((b) => (
              <span key={b.key} className="dash-rcard__badge">
                {b.node}
              </span>
            ))}
          </div>
        ) : null}
        {facts.length > 0 ? (
          <dl className="dash-rcard__facts">
            {facts.map((c) => {
              const label = labelOf(c);
              const empty = c.isEmpty?.(row) ?? false;
              return (
                <div key={c.key} className="dash-rcard__fact" data-wide={c.cardWide || undefined}>
                  {label ? <dt>{label}</dt> : null}
                  <dd>
                    {empty ? (
                      <span className="dash-muted">{strings.table.empty}</span>
                    ) : (
                      <Truncate lines={c.cardWide ? 2 : 1}>{(c.cardCell ?? c.cell)(row)}</Truncate>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : null}
        {hasDetails ? (
          <div className="dash-rcard__details">
            {inline.length > 0 ? (
              <dl className="dash-rcard__inline">
                {inline.map((c) => {
                  const label = labelOf(c);
                  return (
                    <div key={c.key} className="dash-rcard__ditem">
                      {label ? <dt>{label}</dt> : null}{" "}
                      <dd>{(c.cardCell ?? c.cell)(row)}</dd>
                    </div>
                  );
                })}
              </dl>
            ) : null}
            {blocks.map((c) => {
              const label = labelOf(c);
              return (
                <dl key={c.key} className="dash-rcard__text">
                  {label ? <dt>{label}</dt> : null}
                  <dd>{(c.cardCell ?? c.cell)(row)}</dd>
                </dl>
              );
            })}
          </div>
        ) : null}
        {actionsNode ? (
          <div className="dash-rcard__actions" data-no-row-click="true" data-rule={hasDetails ? undefined : true}>
            {actionsNode}
          </div>
        ) : null}
      </article>
    </li>
  );
});
