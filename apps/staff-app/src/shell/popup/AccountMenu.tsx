import { Avatar, Button } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-bold-duotone";
import IconLogout from "~icons/solar/logout-2-bold-duotone";

import { useShell } from "../../lib/store";
import { call } from "../../lib/tauri";

/** Avatar, name, role, Lock and Log out. */
export function AccountMenu() {
  const session = useShell((s) => s.session);
  const employee = session.status === "signedIn" ? session.employee : null;

  if (!employee) {
    return (
      <div style={{ padding: 20, color: "var(--rb-muted)" }} data-testid="account-menu">
        Nobody is signed in.
      </div>
    );
  }

  return (
    <div
      data-testid="account-menu"
      style={{
        height: "100%",
        boxSizing: "border-box",
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Avatar name={employee.name} size={48} decorative />
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>{employee.name}</h2>
          {employee.role ? (
            <div style={{ marginTop: 2, fontSize: 13, color: "var(--rb-muted)" }}>{employee.role}</div>
          ) : null}
        </div>
      </div>
      <Button
        variant="ghost"
        style={{ width: "100%" }}
        onClick={() => {
          void call("lock", {});
        }}
      >
        <IconLock width={18} height={18} />
        Lock
      </Button>
      <Button
        variant="danger-ghost"
        style={{ width: "100%" }}
        onClick={() => void call("popup_open", { kind: "confirm", anchor: null })}
      >
        <IconLogout width={18} height={18} />
        Log out
      </Button>
    </div>
  );
}
