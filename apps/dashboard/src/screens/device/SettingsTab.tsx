import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button, InfoTip, Pill, SearchSelect, Switch } from "@rulebox/ui";
import IconPen from "~icons/solar/pen-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import { useMoveDevice, useRemoveDevice, useRequestRotation, useRevokeDevice, useSetKiosk } from "../../data";
import { useDeviceSettingsOptions } from "../../data/devices";
import type { DevicePage, DeviceSettingsOptions, QueryState } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { messageFor } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { useCan } from "../../lib/member";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { DeviceDisplayCard } from "../display/DeviceDisplayCard";
import { RingPicker } from "./RingPicker";
import { settingsText as s } from "./settingsStrings";

const RenameDialog = lazy(() => import("./RenameDialog").then((m) => ({ default: m.RenameDialog })));

const REMOVE_ID = "dev-remove";

type Options = QueryState<DeviceSettingsOptions> | null;
type Focus = "group" | "remove" | undefined;

/**
 * The Settings tab (UI pass step 9): General (name, group), Kiosk mode, Display and memory, Advanced (who gets changes first, a new
 * key) and the Danger zone. Only an administrator who can still change this PC subscribes to `fleet:deviceSettings` (the group list
 * and the rollout revision); a viewer or a disconnected PC reads values and subscribes to nothing. `focus` names the control a
 * problem card sent the administrator here for ("Choose a group", "Remove this PC").
 */
export default function SettingsTab({ d, focus }: { d: DevicePage; focus?: Focus }) {
  const canAct = useCan("admin") && !d.revoked;
  return canAct ? <WithOptions d={d} focus={focus} /> : <Cards d={d} focus={focus} options={null} />;
}

function WithOptions({ d, focus }: { d: DevicePage; focus: Focus }) {
  const options = useDeviceSettingsOptions(d._id);
  return <Cards d={d} focus={focus} options={options} />;
}

function Cards({ d, focus, options }: { d: DevicePage; focus: Focus; options: Options }) {
  const admin = useCan("admin");
  return (
    <div className="set" data-revoked={d.revoked || undefined}>
      <div className="set__general">
        <General d={d} focus={focus} options={options} />
      </div>
      {d.revoked ? null : (
        <>
          <div className="set__kiosk">
            <Kiosk d={d} />
          </div>
          <div className="set__display">
            <DeviceDisplayCard d={d} />
          </div>
          <div className="set__advanced">
            <Advanced d={d} options={options} />
          </div>
        </>
      )}
      {admin ? (
        <div className="set__danger">
          <Danger d={d} focus={focus} />
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dash-kv__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- General

function General({ d, focus, options }: { d: DevicePage; focus: Focus; options: Options }) {
  const canAct = useCan("admin") && !d.revoked;
  const [renaming, setRenaming] = useState(false);
  return (
    <Card title={s.general}>
      <div className="dash-form">
        <div className="set-name">
          <div className="set-name__text">
            <span className="set-name__label">{s.name}</span>
            <span className="set-name__value" title={d.name}>
              {d.name}
            </span>
          </div>
          {canAct ? (
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              <IconPen aria-hidden="true" />
              {s.rename}
            </Button>
          ) : null}
        </div>
        <hr className="dash-divider" />
        {canAct && options !== null ? (
          <QueryRegion state={options} skeleton={<SkeletonBlock lines={2} />}>
            {(o) => <MoveForm d={d} groups={o.groups} focus={focus === "group"} />}
          </QueryRegion>
        ) : (
          <dl className="dash-kv set-kv">
            <Row label={s.group}>{d.group?.name ?? s.noGroup}</Row>
          </dl>
        )}
        <dl className="dash-kv set-kv">
          <Row label={s.enrolled}>{formatDate(d.enrolledAt)}</Row>
        </dl>
      </div>
      <Suspense fallback={null}>{renaming ? <RenameDialog d={d} open onClose={() => setRenaming(false)} /> : null}</Suspense>
    </Card>
  );
}

function MoveForm({ d, groups, focus }: { d: DevicePage; groups: DeviceSettingsOptions["groups"]; focus: boolean }) {
  const move = useMoveDevice();
  const toast = useToast();
  const [groupId, setGroupId] = useState(d.group?._id ?? "");
  const [base, setBase] = useState({ groupId: d.group?._id ?? "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldId = useRef<string | null>(null);
  const changed = groupId !== base.groupId && groupId !== "";
  // Arrived from "Choose a group": the picker takes the focus once its options are there.
  useEffect(() => {
    if (focus && fieldId.current) document.getElementById(fieldId.current)?.focus();
  }, [focus]);
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
      <Field label={s.group} info={s.groupInfo}>
        {(p) => {
          fieldId.current = p.id;
          return (
            <SearchSelect
              {...p}
              value={groupId}
              onChange={setGroupId}
              disabled={pending}
              placeholder={s.chooseGroup}
              searchPlaceholder={s.groupSearch}
              emptyText={s.groupEmpty}
              options={groups.map((g) => ({ value: g._id, label: g.name }))}
            />
          );
        }}
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

// ---------------------------------------------------------------- Kiosk mode

function Kiosk({ d }: { d: DevicePage }) {
  const canAct = useCan("admin");
  const setKiosk = useSetKiosk();
  const toast = useToast();
  const on = d.kioskEnabled;
  return (
    <Card title={s.kiosk} actions={<InfoTip label={`About ${s.kiosk}`}>{s.kioskInfo}</InfoTip>}>
      <div className="set-kiosk" data-on={on || undefined}>
        <span className="set-kiosk__icon" aria-hidden="true">
          <IconMonitor />
        </span>
        <p className="set-kiosk__text">{on ? s.kioskOnLine : s.kioskOffLine}</p>
        {canAct ? (
          <Switch
            checked={on}
            label={on ? s.kioskOn : s.kioskOff}
            onChange={(enabled) => setKiosk({ deviceId: d._id, expectedRevision: d.revision, enabled }).catch((e) => toast(messageFor(e), "danger"))}
          />
        ) : (
          <Pill tone={on ? "success" : "warning"}>{on ? s.kioskOn : s.kioskOff}</Pill>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Advanced

function Advanced({ d, options }: { d: DevicePage; options: Options }) {
  const canAct = useCan("admin");
  const rotate = useRequestRotation();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  return (
    <Card title={s.advanced} body="none">
      <div className="set-adv">
        <RingPicker d={d} options={options} />
        {canAct ? (
          <div className="set-adv__row">
            <div className="set-adv__text">
              <span className="set-adv__title">
                {s.rotate}
                <InfoTip label={`About ${s.rotate}`}>{s.rotateInfo}</InfoTip>
              </span>
              {d.flags.rotateCredential ? <span className="dash-muted">{s.rotatePending}</span> : null}
            </div>
            <Button variant="ghost" onClick={() => setAsking(true)} disabled={d.flags.rotateCredential}>
              {s.rotateAction}
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={asking}
        title={s.rotateTitle}
        body={s.rotateBody}
        confirmLabel={s.rotateAction}
        onConfirm={() => rotate({ deviceId: d._id })}
        onDone={() => toast(s.rotateRequested)}
        onClose={() => setAsking(false)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Danger zone

function Danger({ d, focus }: { d: DevicePage; focus: Focus }) {
  const navigate = useNavigate();
  const toast = useToast();
  const revoke = useRevokeDevice();
  const remove = useRemoveDevice();
  const [dialog, setDialog] = useState<"revoke" | "remove" | null>(null);
  // Arrived from "Remove this PC": the button takes the focus.
  useEffect(() => {
    if (focus === "remove") document.getElementById(REMOVE_ID)?.focus();
  }, [focus]);
  return (
    <Card title={s.dangerZone} tone="danger">
      {d.revoked ? (
        <div className="set-danger__row">
          <div className="set-danger__text">
            <span className="set-danger__title">
              {s.remove}
              <InfoTip label={`About ${s.remove}`}>{s.removeInfo}</InfoTip>
            </span>
            <span className="dash-muted">{s.disconnectedNote}</span>
          </div>
          <Button id={REMOVE_ID} variant="danger-ghost" onClick={() => setDialog("remove")}>
            {s.remove}
          </Button>
        </div>
      ) : (
        <div className="set-danger__row">
          <div className="set-danger__text">
            <span className="set-danger__title">
              {s.revoke}
              <InfoTip label={`About ${s.revoke}`}>{s.revokeInfo}</InfoTip>
            </span>
            <span className="dash-muted">{s.revokeLine}</span>
          </div>
          <Button variant="danger-ghost" onClick={() => setDialog("revoke")}>
            {s.revoke}
          </Button>
        </div>
      )}
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
        confirmLabel={s.remove}
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
