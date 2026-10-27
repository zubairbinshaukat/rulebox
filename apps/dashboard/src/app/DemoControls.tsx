import { useState } from "react";
import { Button, SegmentedControl, Switch } from "@rulebox/ui";
import IconTuning from "~icons/solar/tuning-2-linear";
import { useDemoControls } from "../data/demo/controls";
import type { Role } from "../data/types";
import { Modal } from "../components/Modal";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";

type RoleChoice = Role | "real";

const ROLES = [
  { value: "real", label: "Me" },
  { value: "owner", label: strings.app.roles.owner },
  { value: "admin", label: strings.app.roles.admin },
  { value: "viewer", label: strings.app.roles.viewer },
] as const;

/** Demo-only panel (lazy-loaded; never in a live build): roles, slow network, connection loss, failures, stale edits. */
export default function DemoControls() {
  const [open, setOpen] = useState(false);
  const demo = useDemoControls();
  const toast = useToast();
  const d = strings.demo;
  return (
    <>
      <button
        type="button"
        className="dash-icon-btn"
        aria-label={d.open}
        title={d.open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <IconTuning aria-hidden="true" />
      </button>
      <Modal open={open} title={d.title} onClose={() => setOpen(false)} actions={<Button onClick={() => setOpen(false)}>{strings.common.done}</Button>}>
        <div className="dash-demo-panel">
          <p className="dash-muted">{strings.demo.banner}</p>
          <div className="dash-field">
            <span className="dash-field__label" id="demo-role">
              {d.role}
            </span>
            <SegmentedControl<RoleChoice>
              aria-label={d.role}
              options={ROLES}
              value={demo.role ?? "real"}
              onChange={(v) => demo.setRole(v === "real" ? null : v)}
            />
          </div>
          <Switch checked={demo.controls.slow} onChange={(v) => demo.setControls({ slow: v })} label={d.slow} />
          <Switch checked={demo.controls.offline} onChange={(v) => demo.setControls({ offline: v })} label={d.offline} />
          <Switch checked={demo.controls.failQueries} onChange={(v) => demo.setControls({ failQueries: v })} label={d.failQueries} />
          <div className="dash-row">
            <Button
              variant="ghost"
              onClick={() => {
                demo.simulateConcurrentEdit();
                toast(d.staleEditDone, "info");
              }}
            >
              {d.staleEdit}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                demo.reset();
                toast(d.resetDone, "info");
              }}
            >
              {d.reset}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
