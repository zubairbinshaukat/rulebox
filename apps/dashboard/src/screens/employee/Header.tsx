import { Link } from "react-router";
import { Avatar, Pill } from "@rulebox/ui";
import IconBack from "~icons/solar/alt-arrow-left-linear";
import type { EmployeeDetail as Detail } from "../../data/types";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import { employeesStrings } from "../../lib/screenStrings/employees";

/**
 * The top of the employee page, built like the device and group pages: the way back, the name (the page's one `h1`) with a big
 * initial, the state in a pill and the sign-in name. "Add employee" has the title and nothing else.
 */
export function EmployeeHeader({ d }: { d?: Detail }) {
  return (
    <header className="emp-head">
      <Link to="/employees" className="dash-head__back">
        <IconBack aria-hidden="true" />
        {s.back}
      </Link>
      {d ? (
        <div className="emp-head__who">
          <Avatar name={d.name} size={56} decorative className="emp-head__avatar" />
          <div className="emp-head__id">
            <h1 className="emp-head__name" title={d.name} tabIndex={-1} data-page-title>
              {d.name}
            </h1>
            <div className="emp-head__meta">
              {d.disabled ? (
                <Pill tone="neutral" dot>
                  {employeesStrings.disabled}
                </Pill>
              ) : (
                <Pill tone="success" dot>
                  {employeesStrings.active}
                </Pill>
              )}
              <span className="emp-head__user">
                <span className="emp-head__label">{s.username}</span> <span className="dash-mono">{d.username}</span>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <h1 className="emp-head__name" tabIndex={-1} data-page-title>
          {s.newTitle}
        </h1>
      )}
    </header>
  );
}
