import { useId } from "react";
import { Button } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-bold-duotone";
import { Modal } from "../../components/Modal";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import { GeneratedPassword } from "./GeneratedPassword";

/**
 * Shown once, right after "Create employee" with a generated password: "Maria is added. Give her this password." The password comes
 * from the parent's state and goes nowhere else (no storage, no router state, no URL). Closing it, any way, leaves the page for
 * the new employee, and the password is gone; "New password" on that page makes another.
 */
export function HandoverDialog({ name, username, password, onDone }: { name: string; username: string; password: string; onDone: () => void }) {
  const label = useId();
  return (
    <Modal
      open
      title={s.createdTitle(name)}
      onClose={onDone}
      className="emp-handover"
      actions={
        <Button onClick={onDone}>
          {s.handoverDone}
        </Button>
      }
    >
      <div className="emp-hand">
        <span className="emp-hand__icon" aria-hidden="true">
          <IconCheck />
        </span>
        <p className="emp-hand__lead" id={label}>
          {s.handoverBody}
        </p>
        <GeneratedPassword value={password} labelledBy={label} />
        <p className="emp-hand__who">
          {s.handoverSignIn} <strong className="dash-mono">{username}</strong>.
        </p>
      </div>
    </Modal>
  );
}
