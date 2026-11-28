import { useMemo, type RefObject } from "react";
import { Link } from "react-router";
import { Pill } from "@rulebox/ui";
import type { AssignmentRow } from "../../data/types";
import { AppGlyph } from "../../components/AppGlyph";
import { Card } from "../../components/Card";
import { DataTable, type Column, type RowAction } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useCan } from "../../lib/member";
import { groupStrings } from "../../lib/screenStrings/group";
import { strings } from "../../lib/strings";
import { groupPage as t } from "./strings";

interface AppsCardProps {
  assignments: AssignmentRow[];
  onEdit: (a: AssignmentRow) => void;
  onUnassign: (a: AssignmentRow) => void;
  /** The card's box: the "Apps" tile scrolls to it and focuses it. */
  cardRef?: RefObject<HTMLDivElement | null>;
}

/**
 * The apps the group's PCs get (`groups:get`): the same list as a table or as cards (the person's global choice; a phone starts
 * with cards, where the Edit and Unassign buttons are part of every card). The header's Assign app adds one; the buttons here
 * change how one appears or take it away.
 */
export function AppsCard({ assignments, onEdit, onUnassign, cardRef }: AppsCardProps) {
  const canAct = useCan("admin");
  const cols = useMemo<Column<AssignmentRow>[]>(() => {
    const actionsOf = (a: AssignmentRow): RowAction[] =>
      canAct ? [{ label: t.edit, onSelect: () => onEdit(a) }, { label: groupStrings.unassign, danger: true, onSelect: () => onUnassign(a) }] : [];
    return [
      {
        key: "app",
        header: t.colApp,
        primary: true,
        type: "name",
        maxWidth: 240,
        cell: (a) => (
          <span className="grp-app">
            <AppGlyph name={a.appName} hue={a.hue} kind={a.appKind} />
            <Link className="dash-link dash-link--plain grp-app__name" to={`/apps/${a.appId}`} title={a.appName}>
              {a.appName}
            </Link>
            {a.archived ? <Pill tone="warning">{t.archived}</Pill> : null}
          </span>
        ),
      },
      {
        key: "audience",
        header: t.colWho,
        type: "short",
        card: "fact",
        cell: (a) => (a.audience === "everyone" ? t.everyone : t.chosen),
      },
      {
        key: "pins",
        header: t.colPins,
        type: "short",
        card: "fact",
        isEmpty: (a) => !a.pinnedTaskbar && !a.pinnedDesktop,
        cell: (a) => [a.pinnedTaskbar ? groupStrings.pinnedTaskbar : null, a.pinnedDesktop ? groupStrings.pinnedDesktop : null].filter(Boolean).join(" · "),
      },
      { key: "act", header: strings.common.actions, actions: true, rowActions: actionsOf, isEmpty: (a) => actionsOf(a).length === 0, cell: () => null },
    ];
  }, [canAct, onEdit, onUnassign]);

  return (
    <div ref={cardRef} className="grp-apps" id="grp-apps" tabIndex={-1}>
      <Card title={t.apps} actions={<span className="grp-count">{t.appsCount(assignments.length)}</span>} body="none" className="dash-card--tight">
        <div className="grp-apps__body">
          {assignments.length === 0 ? (
            <EmptyState compact title={t.appsNone} />
          ) : (
            <DataTable caption={t.apps} columns={cols} rows={assignments} getKey={(a) => a._id} rowLabel={(a) => a.appName} isDim={(a) => a.archived === true} />
          )}
        </div>
      </Card>
    </div>
  );
}
