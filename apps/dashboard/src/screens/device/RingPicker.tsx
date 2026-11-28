import { useState } from "react";
import { Select } from "@rulebox/ui";
import { useSetRings } from "../../data";
import { RINGS, type DevicePage, type DeviceSettingsOptions, type QueryState, type Ring } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { ringErrorMessage, settingsText as s } from "./settingsStrings";

/**
 * "Gets changes": the PC's rollout ring (plan 4.14, 4.20; PRD 24.3), moved here from the Lockdown card (device page plan D14).
 * `rollouts:setRings` for this one PC with the rollout revision of `fleet:deviceSettings`, so nothing extra is read. A viewer reads it.
 */
export function RingPicker({ d, options }: { d: Pick<DevicePage, "_id" | "ring" | "group" | "revoked">; options: QueryState<DeviceSettingsOptions> | null }) {
  const setRings = useSetRings();
  const canAct = useCan("admin");
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const groupId = d.group?._id;
  if (groupId === undefined) return <p className="dash-muted">{s.ringNoGroup}</p>;
  if (!canAct || d.revoked || options === null) {
    return (
      <dl className="dash-kv">
        <div className="dash-kv__item">
          <dt>{s.ring}</dt>
          <dd>{s.rings[d.ring]}</dd>
        </div>
      </dl>
    );
  }
  // The revision comes with the Settings tab's query: until it has answered there is nothing to send, so the choice waits.
  const revision = options.status === "ready" ? options.data.rolloutRevision : null;
  return (
    <>
      <Field label={s.ring} info={s.ringInfo}>
        {(p) => (
          <Select
            {...p}
            value={d.ring}
            disabled={pending || revision === null}
            options={RINGS.map((r) => ({ value: r, label: s.rings[r] }))}
            onChange={(value) => {
              if (revision === null) return;
              setPending(true);
              setError(null);
              setRings({ groupId, deviceIds: [d._id], ring: value as Ring, expectedRevision: revision }).then(
                () => {
                  setPending(false);
                  toast(s.ringSaved);
                },
                (err) => {
                  setPending(false);
                  setError(err);
                },
              );
            }}
          />
        )}
      </Field>
      <FormError error={error} onReload={() => setError(null)} describe={ringErrorMessage} />
    </>
  );
}
