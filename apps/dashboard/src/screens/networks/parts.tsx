import { useEffect, useRef, useState, type ReactNode } from "react";
import { Checkbox, InfoTip, Switch } from "@rulebox/ui";
import type { GroupRow, QueryState } from "../../data/types";
import { FieldSet } from "../../components/Field";
import { RegionError } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { networksStrings as n } from "./strings";

/**
 * "Advanced": a disclosure that stays closed unless the admin opens it, or one of its fields has an error (then it opens by itself, so
 * an error is never hidden in a closed box). The fields stay mounted while it is closed, so what was typed in them is never lost.
 */
export function AdvancedBox({ forceOpen = false, title = n.advanced, children }: { forceOpen?: boolean; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  return (
    <details className="dash-advanced net-adv" open={shown}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen(!shown);
        }}
      >
        {title}
      </summary>
      <div className="dash-advanced__body">{children}</div>
    </details>
  );
}

/**
 * "Which PCs get it?": the groups as a tick list. A new item with exactly one group in the organization starts with that group ticked
 * (`autoPick`): the admin has nothing to decide.
 */
export function GroupPicker({
  groups,
  selected,
  onChange,
  error,
  autoPick = false,
}: {
  /** `useGroupsScreen()` of the form (it also names the groups elsewhere in the form). */
  groups: QueryState<GroupRow[]>;
  selected: string[];
  onChange: (ids: string[]) => void;
  error?: string | null;
  autoPick?: boolean;
}) {
  const picked = useRef(false);
  const only = groups.status === "ready" && groups.data.length === 1 ? (groups.data[0]?._id ?? null) : null;
  useEffect(() => {
    if (!autoPick || picked.current || only === null) return;
    picked.current = true;
    if (selected.length === 0) onChange([only]);
  }, [autoPick, only, selected.length, onChange]);

  return (
    <FieldSet legend={n.whichPcs} info={n.whichPcsInfo} error={error}>
      {groups.status === "loading" ? (
        <SkeletonBlock lines={2} />
      ) : groups.status === "error" ? (
        <RegionError error={groups.error} onRetry={groups.retry} />
      ) : groups.data.length === 0 ? (
        <p className="dash-muted">{n.noGroupsExist}</p>
      ) : (
        <div className="dash-checks net-checks">
          {groups.data.map((g) => (
            <Checkbox
              key={g._id}
              label={g.name}
              checked={selected.includes(g._id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, g._id] : selected.filter((x) => x !== g._id))}
            />
          ))}
        </div>
      )}
    </FieldSet>
  );
}

/** The short "How it works" card beside a new item's form (laptop and wider). Its lines are the (i) of the header on smaller screens. */
export function HowCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <aside className="dash-card net-how" aria-label={title}>
      <h2 className="net-how__title">{title}</h2>
      <ul className="net-how__list">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </aside>
  );
}

/** A switch with its label and an (i) next to it; the explanation is not kept in the form. */
export function SwitchRow({ checked, onChange, label, info }: { checked: boolean; onChange: (on: boolean) => void; label: string; info: ReactNode }) {
  return (
    <div className="net-switch">
      <Switch checked={checked} onChange={onChange} label={label} />
      <InfoTip label={`About ${label}`}>{info}</InfoTip>
    </div>
  );
}