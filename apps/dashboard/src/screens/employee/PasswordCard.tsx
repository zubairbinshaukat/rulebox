import { lazy, Suspense, useState } from "react";
import { Button } from "@rulebox/ui";
import IconKey from "~icons/solar/key-linear";
import type { EmployeeDetail as Detail } from "../../data/types";
import { Card } from "../../components/Card";
import { RelativeTime } from "../../components/RelativeTime";
import { RoleGate } from "../../components/RoleGate";
import { employeeStrings as s } from "../../lib/screenStrings/employee";

// The dialog loads when it is opened: most visits never set a password.
const SetPasswordDialog = lazy(() => import("./SetPasswordDialog").then((m) => ({ default: m.SetPasswordDialog })));

/** "Set 3 days ago" and one button. A password is never shown here: the server keeps only a scrambled copy. */
export function PasswordCard({ d }: { d: Detail }) {
  const [open, setOpen] = useState(false);
  const set = d.passwordSet && d.passwordSetAt !== undefined;
  return (
    <Card title={s.password} className="emp-pwcard">
      <div className="emp-pwrow" data-set={set || undefined}>
        <span className="emp-pwrow__icon" aria-hidden="true">
          <IconKey />
        </span>
        <div className="emp-pwrow__text">
          {set ? (
            <p className="emp-pwrow__title">
              {s.passwordSetPrefix} <RelativeTime ms={d.passwordSetAt!} />
            </p>
          ) : (
            <>
              <p className="emp-pwrow__title">{s.passwordNotSet}</p>
              <p className="emp-pwrow__sub">{s.passwordNotSetBody}</p>
            </>
          )}
        </div>
        <RoleGate minRole="admin">
          <Button variant="ghost" className="emp-pwrow__btn" onClick={() => setOpen(true)}>
            {set ? s.newPassword : s.setPassword}
          </Button>
        </RoleGate>
      </div>
      <Suspense fallback={null}>{open ? <SetPasswordDialog d={d} onClose={() => setOpen(false)} /> : null}</Suspense>
    </Card>
  );
}
