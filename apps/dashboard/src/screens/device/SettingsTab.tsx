import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button, NativeSelect, Pill, Switch } from "@rulebox/ui";
import { useMoveDevice, useRemoveDevice, useRequestRotation, useRevokeDevice, useSetKiosk } from "../../data";
import { useDeviceSettingsOptions } from "../../data/devices";
import type { DevicePage, GroupOption } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { QueryRegion } from "../../components/Region";
import { RoleGate } from "../../components/RoleGate";
import { SkeletonBlock } from "../../components/Skeleton";
import { formatDate } from "../../lib/format";
import { messageFor } from "../../lib/errors";
import { useCan } from "../../lib/member";
import { deviceStrings as s } from "../../lib/screenStrings/device";
import { devicesStrings } from "../../lib/screenStrings/devices";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { DeviceDisplayCard } from "../display/DeviceDisplayCard";

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dash-kv__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * STUB (UI pass step 9 replaces it): today's kiosk switch, group picker, display mode, identity and danger zone cards, in the
 * final arrangement (two columns, the danger zone full width). The group options now come from `fleet:deviceSettings`, subscribed
 * only while an admin has this tab open. Missing from the real tab yet: Rename here, the "Gets changes" ring picker and the
 * "Renew this PC's key" line under Advanced (the ring picker is still in the Protection stub's lockdown card).
 */
export default function SettingsTab({ d, focus }: { d: DevicePage; focus?: "group" | "remove" }) {
  return (
    // `focus` = the control a problem card sent the admin here for ("Choose a group", "Remove this PC"); the real tab focuses it.
    <div className="dash-stack" data-focus={focus}>
      <div className="dash-grid dash-grid--2">
        <General d={d} />
        <DeviceDisplayCard d={d} />
      </div>
      <Card title={s.identity}>
        <dl className="dash-kv">
          <KV label={s.enrolled} value={formatDate(d.enrolledAt)} />
          <KV label="ID" value={<span className="dash-mono">{d._id}</span>} />
        </dl>
      </Card>
      <RoleGate minRole="admin">
        <Danger d={d} />
      </RoleGate>
    </div>
  );
}

function General({ d }: { d: DevicePage }) {
  const canAct = useCan("admin") && !d.revoked;
  const setKiosk = useSetKiosk();
  const toast = useToast();
  return (
    <Card title={strings.app.nav.settings}>
      <div className="dash-form">
        <div className="dash-switch-row">
          <div className="dash-switch-row__text">
            <span className="dash-switch-row__title" id="kiosk-label">
              {s.kiosk}
            </span>
            <span className="dash-switch-row__hint">{s.kioskHelp}</span>
          </div>
          {canAct ? (
            <Switch
              checked={d.kioskEnabled}
              label={d.kioskEnabled ? s.kioskOn : s.kioskOffLabel}
              onChange={(enabled) =>
                setKiosk({ deviceId: d._id, expectedRevision: d.revision, enabled }).catch((e) => toast(messageFor(e), "danger"))
              }
            />
          ) : (
            <Pill tone={d.kioskEnabled ? "success" : "warning"}>{d.kioskEnabled ? s.kioskOn : s.kioskOffLabel}</Pill>
          )}
        </div>
        <hr className="dash-divider" />
        {canAct ? (
          <GroupPicker d={d} />
        ) : (
          <dl className="dash-kv" style={{ gridTemplateColumns: "1fr" }}>
            <KV label={s.group} value={d.group?.name ?? devicesStrings.noGroup} />
          </dl>
        )}
      </div>
    </Card>
  );
}

function GroupPicker({ d }: { d: DevicePage }) {
  const options = useDeviceSettingsOptions(d._id);
  return (
    <QueryRegion state={options} skeleton={<SkeletonBlock lines={2} />}>
      {(o) => <MoveForm d={d} groups={o.groups} />}
    </QueryRegion>
  );
}

function MoveForm({ d, groups }: { d: DevicePage; groups: GroupOption[] }) {
  const move = useMoveDevice();
  const toast = useToast();
  const [groupId, setGroupId] = useState(d.group?._id ?? "");
  const [base, setBase] = useState({ groupId: d.group?._id ?? "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = groupId !== base.groupId && groupId !== "";
  return (
    <form
      className="dash-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed || pending) return;
        setPending(true);
        setError(null);
        move({ deviceId: d._id, expectedRevision: d.revision, groupId }).then(
          () => {
            setPending(false);
            setBase({ groupId });
            toast(strings.common.saved);
          },
          (err) => {
            setPending(false);
            setError(err);
          },
        );
      }}
    >
      <Field label={s.group}>
        {(p) => (
          <NativeSelect {...p} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groupId === "" ? <option value="">{devicesStrings.noGroup}</option> : null}
            {groups.map((g) => (
              <option key={g._id} value={g._id}>
                {g.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <FormError
        error={error}
        onReload={() => {
          setError(null);
          setGroupId(d.group?._id ?? "");
          setBase({ groupId: d.group?._id ?? "" });
        }}
      />
      {changed ? (
        <div className="dash-form__actions">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? strings.common.saving : s.move}
          </Button>
          <Button variant="ghost" onClick={() => setGroupId(base.groupId)} disabled={pending}>
            {strings.common.cancel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function Danger({ d }: { d: DevicePage }) {
  const navigate = useNavigate();
  const toast = useToast();
  const revoke = useRevokeDevice();
  const remove = useRemoveDevice();
  const rotate = useRequestRotation();
  const [dialog, setDialog] = useState<"revoke" | "remove" | "rotate" | null>(null);
  return (
    <Card title={s.dangerZone} tone="danger">
      <div className="dash-form">
        {!d.revoked ? (
          <>
            <div className="dash-row dash-row--between">
              <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.rotateBody}</span>
              <Button variant="ghost" onClick={() => setDialog("rotate")} disabled={d.flags.rotateCredential}>
                {s.rotate}
              </Button>
            </div>
            {d.flags.rotateCredential ? <p className="dash-muted">{s.rotatePending}</p> : null}
            <hr className="dash-divider" />
            <div className="dash-row dash-row--between">
              <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.revokeBody}</span>
              <Button variant="danger-ghost" onClick={() => setDialog("revoke")}>
                {s.revoke}
              </Button>
            </div>
          </>
        ) : (
          <div className="dash-row dash-row--between">
            <span className="dash-muted" style={{ flex: "1 1 200px" }}>{s.removeBody}</span>
            <Button variant="danger-ghost" onClick={() => setDialog("remove")}>
              {strings.common.remove}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={dialog === "rotate"}
        title={s.rotateTitle}
        body={s.rotateBody}
        confirmLabel={s.rotate}
        onConfirm={() => rotate({ deviceId: d._id })}
        onDone={() => toast(s.rotateRequested)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "revoke"}
        title={s.revokeTitle}
        body={s.revokeBody}
        confirmLabel={s.revoke}
        danger
        typeToConfirm={d.name}
        onConfirm={() => revoke({ deviceId: d._id })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "remove"}
        title={s.removeTitle}
        body={s.removeBody}
        confirmLabel={strings.common.remove}
        danger
        typeToConfirm={d.name}
        onConfirm={() => remove({ deviceId: d._id })}
        onDone={() => {
          toast(s.removed(d.name));
          navigate("/devices", { replace: true });
        }}
        onClose={() => setDialog(null)}
      />
    </Card>
  );
}
