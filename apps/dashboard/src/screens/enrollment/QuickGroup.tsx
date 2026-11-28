import { useRef, useState } from "react";
import { Button, Input } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import { useCreateGroup } from "../../data";
import type { Id } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import * as v from "../../lib/validate";
import { enrollText as s } from "./strings";

/** "Your PCs need a group first": a name and one button, so a new organization never has to leave this page (decision 10). */
export function QuickGroup({ onCreated }: { onCreated: (id: Id) => void }) {
  const create = useCreateGroup();
  const [name, setName] = useState<string>(s.firstGroupDefault);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);

  async function submit() {
    if (busy.current) return;
    const bad = v.name(name, v.NAME_MAX.group);
    setProblem(bad);
    if (bad) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      onCreated(await create({ name: name.trim() }));
    } catch (e) {
      setError(e);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="addpc-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="addpc-lead">{s.firstGroup}</p>
      <div className="addpc-form__fields addpc-form__fields--one">
        <Field label={s.firstGroupName} info={s.firstGroupInfo} error={problem} required>
          {(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={100} disabled={pending} />}
        </Field>
      </div>
      <FormError error={error} />
      <div className="addpc-form__foot">
        <span />
        <Button type="submit" className="addpc-primary" disabled={pending} aria-busy={pending}>
          <IconAdd aria-hidden="true" />
          {s.firstGroupCreate}
        </Button>
      </div>
    </form>
  );
}
