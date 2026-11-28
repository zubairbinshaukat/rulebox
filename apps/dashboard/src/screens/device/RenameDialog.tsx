import { useState } from "react";
import { Button, Input } from "@rulebox/ui";
import { useRenameDevice } from "../../data";
import type { DevicePage } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { deviceStrings as s } from "../../lib/screenStrings/device";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import * as v from "../../lib/validate";

/** Rename this PC (`fleet:rename`). The header's pen opens it; the Settings tab offers the same dialog. */
export function RenameDialog({ d, open, onClose }: { d: Pick<DevicePage, "_id" | "name" | "revision">; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <RenameInner d={d} onClose={onClose} />;
}

function RenameInner({ d, onClose }: { d: Pick<DevicePage, "_id" | "name" | "revision">; onClose: () => void }) {
  const rename = useRenameDevice();
  const toast = useToast();
  const [name, setName] = useState(d.name);
  const [revision, setRevision] = useState(d.revision);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const invalid = v.name(name, v.NAME_MAX.device);

  return (
    <Modal
      open
      title={s.renameTitle}
      onClose={() => !pending && onClose()}
      onSubmit={() => {
        setTouched(true);
        if (invalid || pending) return;
        setPending(true);
        setError(null);
        rename({ deviceId: d._id, expectedRevision: revision, name: name.trim() }).then(
          () => {
            toast(strings.common.saved);
            onClose();
          },
          (e) => {
            setPending(false);
            setError(e);
          },
        );
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? strings.common.saving : strings.common.save}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <Field label={s.renameLabel} error={touched ? invalid : null} required>
          {(p) => <Input {...p} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
        </Field>
        <FormError
          error={error}
          onReload={() => {
            setError(null);
            setName(d.name);
            setRevision(d.revision);
          }}
        />
      </div>
    </Modal>
  );
}
