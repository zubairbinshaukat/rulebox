import { Avatar } from "@rulebox/ui";
import IconKey from "~icons/solar/key-linear";
import type { EmployeeDetail as Detail } from "../../data/types";
import { Card } from "../../components/Card";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import type { ProfileValues } from "./profile";

/**
 * The aside of "Add employee": what the choices mean, in one live sentence. Names come from the pickers' own lists (no query, no
 * counts). Nothing here is a control.
 */
export function Summary({ d, values }: { d: Detail; values: ProfileValues }) {
  const name = values.name.trim();
  const names = new Map(d.groupOptions.map((g) => [g._id as string, g.name]));
  const groups = values.groupIds.map((id) => names.get(id)).filter((x): x is string => x !== undefined);
  const extra = values.appIds.length;
  return (
    <Card title={s.summary} className="emp-summary">
      <div className="emp-summary__who">
        <Avatar name={name || "?"} size={48} decorative />
        <div className="emp-summary__id">
          <p className="emp-summary__name" data-empty={name === "" || undefined}>
            {name || s.summaryEmpty}
          </p>
          {values.username ? (
            <p className="emp-summary__user">
              {s.username} <span className="dash-mono">{values.username}</span>
            </p>
          ) : null}
        </div>
      </div>
      {name ? (
        <div className="emp-summary__text" aria-live="polite">
          <p>{s.summaryGroups(name, groups, s.summaryMore)}</p>
          {extra > 0 ? <p>{s.summaryExtra(extra)}</p> : null}
        </div>
      ) : null}
      <p className="emp-summary__note">
        <span className="emp-summary__icon" aria-hidden="true">
          <IconKey />
        </span>
        <span>{values.typed ? s.summaryPasswordTyped : s.summaryPassword}</span>
      </p>
    </Card>
  );
}
