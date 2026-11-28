import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, InfoTip } from "@rulebox/ui";
import { useDeleteEmployee, useSetEmployeeDisabled } from "../../data";
import type { EmployeeDetail as Detail } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { messageFor } from "../../lib/errors";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";

/**
 * "Account": turn the account off (and back on), and delete it once it is off. A neutral card: only the buttons that take something
 * away are red. The longer explanations sit in (i); the line under each title is the one thing to know.
 */
export function AccountCard({ d }: { d: Detail }) {
  const setDisabled = useSetEmployeeDisabled();
  const del = useDeleteEmployee();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<"disable" | "delete" | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Card title={s.status} className="emp-account">
      <div className="emp-acc">
        <div className="emp-acc__row">
          <div className="emp-acc__text">
            <span className="emp-acc__title">
              {d.disabled ? s.accountOff : s.accountOn}
              <InfoTip label={`About ${s.disable}`}>{s.disableInfo}</InfoTip>
            </span>
            <span className="emp-acc__line">{d.disabled ? s.disabledLine : s.activeLine}</span>
          </div>
          {d.disabled ? (
            <Button
              variant="ghost"
              disabled={pending}
              aria-busy={pending}
              onClick={() => {
                setPending(true);
                setDisabled({ employeeId: d._id, disabled: false }).then(
                  () => setPending(false),
                  (e) => {
                    setPending(false);
                    toast(messageFor(e), "danger");
                  },
                );
              }}
            >
              {s.enable}
            </Button>
          ) : (
            <Button variant="danger-ghost" onClick={() => setDialog("disable")}>
              {s.disable}
            </Button>
          )}
        </div>
        <div className="emp-acc__row">
          <div className="emp-acc__text">
            <span className="emp-acc__title">
              {s.deleteRow}
              <InfoTip label={`About ${s.deleteRow}`}>{s.deleteInfo}</InfoTip>
            </span>
            <span className="emp-acc__line">{d.disabled ? s.deleteLine : s.deleteNeedsDisable}</span>
          </div>
          {d.disabled ? (
            <Button variant="danger-ghost" onClick={() => setDialog("delete")}>
              {strings.common.delete}
            </Button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={dialog === "disable"}
        title={s.disableTitle}
        body={s.disableBody}
        confirmLabel={s.disable}
        danger
        onConfirm={() => setDisabled({ employeeId: d._id, disabled: true })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={s.deleteTitle}
        body={s.deleteBody}
        confirmLabel={strings.common.delete}
        danger
        typeToConfirm={d.username}
        onConfirm={() => del({ employeeId: d._id })}
        onDone={() => {
          toast(s.deleted(d.name));
          navigate("/employees", { replace: true });
        }}
        onClose={() => setDialog(null)}
      />
    </Card>
  );
}
