import { useState } from "react";
import { Button, InfoTip, Select, type SelectOption } from "@rulebox/ui";
import { useSetDeviceDisplayMode } from "../../data";
import type { DevicePage, DisplayChoice } from "../../data/types";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { InlineNotice } from "../../components/Notice";
import { RoleGate } from "../../components/RoleGate";
import { useToast } from "../../lib/toast";
import { messageFor } from "../../lib/errors";
import { strings } from "../../lib/strings";
import { displayStrings as s } from "../../lib/screenStrings/display";
import { standardOnSmallPc } from "./rules";

const modeName = (m: DisplayChoice) => (m === "lite" ? s.modeLite : m === "standard" ? s.modeStandard : s.modeAuto);

const MODES: SelectOption[] = [
  { value: "auto", label: s.modeAuto },
  { value: "standard", label: s.modeStandard },
  { value: "lite", label: s.modeLite },
];

/** What the card reads of a PC (the device page has it all); an older server has no display fields. */
export type DisplayTarget = Pick<DevicePage, "_id" | "revision" | "revoked"> &
  Partial<Pick<DevicePage, "displayMode" | "groupDisplayMode">> & { report?: { ramMb?: number } | null };

/**
 * This PC's own display mode (`fleet:setDisplayMode`). Wins over the group's; `auto` hands it back to the group. The long
 * explanations are (i) tips; only the group's own choice stays visible, because that is what the administrator acts on.
 */
export function DeviceDisplayCard({ d }: { d: DisplayTarget }) {
  const set = useSetDeviceDisplayMode();
  const toast = useToast();
  const saved = d.displayMode ?? "auto";
  const group = d.groupDisplayMode ?? "auto";
  const [mode, setMode] = useState<DisplayChoice>(saved);
  const [pending, setPending] = useState(false);
  const warn = standardOnSmallPc(mode, group, d.report?.ramMb);

  return (
    <Card title={s.title} actions={<InfoTip label={`About ${s.title}`}>{`${s.deviceLead} ${s.groupLead}`}</InfoTip>}>
      <RoleGate minRole="admin" fallback={<p className="dash-muted">{`${s.mode}: ${modeName(saved)}`}</p>}>
        <form
          className="dash-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === saved || pending || d.revoked) return;
            setPending(true);
            set({ deviceId: d._id, expectedRevision: d.revision, displayMode: mode }).then(
              () => {
                setPending(false);
                toast(s.saved);
              },
              (err) => {
                setPending(false);
                toast(messageFor(err), "danger");
              },
            );
          }}
        >
          <Field label={s.mode} info={s.autoNote} hint={group === "auto" ? undefined : s.groupChoice(modeName(group))}>
            {(p) => <Select {...p} value={mode} disabled={d.revoked} options={MODES} onChange={(v) => setMode(v as DisplayChoice)} />}
          </Field>
          {warn ? <InlineNotice tone="warning" title={s.standardOnSmallPc} /> : null}
          <div className="dash-form__actions">
            <Button type="submit" disabled={mode === saved || pending || d.revoked} aria-busy={pending}>
              {pending ? strings.common.saving : strings.common.save}
            </Button>
          </div>
        </form>
      </RoleGate>
    </Card>
  );
}
