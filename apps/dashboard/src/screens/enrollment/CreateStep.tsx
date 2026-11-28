import { useMemo, useRef, useState } from "react";
import { Button, Input, SearchSelect, Select } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-linear";
import IconMinus from "~icons/solar/minus-linear";
import IconKey from "~icons/solar/key-minimalistic-linear";
import { usePlan } from "../../data";
import { useCreateEnrollmentCode } from "../../data/enrollment";
import type { EnrollmentCreated, GroupRow, Id } from "../../data/types";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { toAppError } from "../../lib/errors";
import { formatDuration } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { plan as planText, UNLIMITED } from "../settings/strings";
import {
  autoLabel,
  clampUses,
  DEFAULT_TTL_MINUTES,
  DEFAULT_USES,
  enrollErrorMessage,
  enrollFieldError,
  labelProblem,
  pickDefaultGroup,
  readLastGroup,
  writeLastGroup,
} from "./model";
import { QuickGroup } from "./QuickGroup";
import { enrollText as s } from "./strings";
import { WizardFrame } from "./WizardFrame";

/** What the person chose in step 1. Kept by the wizard so "Add another PC" and "Create a new code" start from the same values. */
export interface CodeSettings {
  groupId: Id;
  uses: number;
  ttlMinutes: number;
  /** The name typed under "More options"; empty = the automatic one. */
  label: string;
}

/** A code just created: kept only in the wizard's state, never fetched again (plan 4.7). */
export interface CreatedCode extends EnrollmentCreated {
  uses: number;
  groupName?: string;
  settings: CodeSettings;
}

export interface CreateStepProps {
  groups: GroupRow[];
  /** From `?group=` (the group page's "Add PCs"): preselected when it still exists. */
  groupParam?: string | null;
  /** The settings of the last code: the form starts from them. */
  initial?: CodeSettings | null;
  focus?: boolean;
  onCreated: (created: CreatedCode) => void;
  /** Focuses the list of codes (the plan limit message offers it). */
  onSeeCodes: () => void;
}

const SEARCH_FROM = 6;

/** Step 1. With the defaults this is one click: the group is the one used last, one PC, one day. */
export function CreateStep({ groups, groupParam, initial, focus, onCreated, onSeeCodes }: CreateStepProps) {
  const create = useCreateEnrollmentCode();
  const plan = usePlan();
  // The day in the automatic name; it moves on its own clock, never inside the handlers.
  const now = useNow(30_000);
  const p = plan.status === "ready" ? plan.data : null;

  const sorted = useMemo(() => [...groups].sort((a, b) => a.name.localeCompare(b.name)), [groups]);
  const [picked, setPicked] = useState<Id | null>(null);
  const defaultGroup = useMemo(() => {
    if (initial && groups.some((g) => g._id === initial.groupId)) return initial.groupId;
    if (groupParam && groups.some((g) => g._id === groupParam)) return groupParam;
    return pickDefaultGroup(groups, readLastGroup());
  }, [groups, initial, groupParam]);
  const groupId = picked !== null && groups.some((g) => g._id === picked) ? picked : defaultGroup;
  const group = groups.find((g) => g._id === groupId);

  const [usesText, setUsesText] = useState(String(initial?.uses ?? DEFAULT_USES));
  const [ttl, setTtl] = useState(initial?.ttlMinutes ?? DEFAULT_TTL_MINUTES);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [open, setOpen] = useState((initial?.label ?? "") !== "" || (initial?.ttlMinutes ?? DEFAULT_TTL_MINUTES) !== DEFAULT_TTL_MINUTES);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);

  const uses = clampUses(Number(usesText.trim() === "" ? DEFAULT_USES : usesText));
  const ttlLabel = s.expiryOptions.find((o) => o.minutes === ttl)?.label ?? formatDuration(ttl * 60_000);
  const serverTtl = enrollFieldError(error, "ttlMinutes");
  const serverLabel = enrollFieldError(error, "label");
  const serverUses = enrollFieldError(error, "uses");

  const limit = p?.limits.maxEnrollmentCodesActive;
  const codeUsage = p && limit !== undefined && limit < UNLIMITED && p.usage.enrollmentCodes >= limit - 1 ? s.usage(p.usage.enrollmentCodes, limit, planText.names[p.plan]) : null;
  const devicesFull = p !== null && p.limits.maxDevices < UNLIMITED && p.usage.devices >= p.limits.maxDevices;
  const appErr = toAppError(error);
  const codeLimit = appErr?.code === "plan_limit" && appErr.detail !== "suspended";

  async function submit() {
    if (busy.current || !group) return;
    const problem = labelProblem(label);
    setLabelError(problem);
    if (problem) {
      setOpen(true);
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    setUsesText(String(uses));
    try {
      const typed = label.trim();
      const made = await create({ groupId: group._id, uses, ttlMinutes: ttl, label: typed || autoLabel(group.name, now) });
      writeLastGroup(group._id);
      onCreated({ ...made, uses, groupName: group.name, settings: { groupId: group._id, uses, ttlMinutes: ttl, label: typed } });
    } catch (e) {
      setError(e);
      if (enrollFieldError(e, "ttlMinutes") || enrollFieldError(e, "label")) setOpen(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (groups.length === 0) {
    return (
      <WizardFrame step={1} heading={s.createHeading} focus={focus}>
        <QuickGroup onCreated={setPicked} />
      </WizardFrame>
    );
  }

  const GroupSelect = sorted.length > SEARCH_FROM ? SearchSelect : Select;

  return (
    <WizardFrame step={1} heading={s.createHeading} focus={focus}>
      <form
        className="addpc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <div className="addpc-form__fields">
          <Field label={s.group} info={s.groupInfo} required>
            {(fp) => (
              <GroupSelect
                {...fp}
                value={groupId ?? ""}
                onChange={setPicked}
                placeholder={s.pickGroup}
                searchPlaceholder={s.groupSearch}
                emptyText={s.groupEmpty}
                disabled={pending}
                options={sorted.map((g) => ({ value: g._id, label: g.name }))}
              />
            )}
          </Field>
          <Field label={s.uses} info={s.usesInfo} error={serverUses} required>
            {(fp) => (
              <div className="addpc-count">
                <Button
                  variant="ghost"
                  icon
                  onClick={() => setUsesText(String(clampUses(uses - 1)))}
                  disabled={pending || uses <= 1}
                  aria-label={s.fewer}
                >
                  <IconMinus aria-hidden="true" />
                </Button>
                <Input
                  {...fp}
                  className="addpc-count__input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={3}
                  value={usesText}
                  disabled={pending}
                  onChange={(e) => setUsesText(e.target.value.replace(/\D/g, ""))}
                  onBlur={() => setUsesText(String(uses))}
                />
                <Button
                  variant="ghost"
                  icon
                  onClick={() => setUsesText(String(clampUses(uses + 1)))}
                  disabled={pending || uses >= 100}
                  aria-label={s.more}
                >
                  <IconAdd aria-hidden="true" />
                </Button>
              </div>
            )}
          </Field>
        </div>

        <details className="dash-advanced" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>{s.advanced}</summary>
          <div className="dash-advanced__body">
            <div className="dash-form-grid">
              <Field label={s.expiry} error={serverTtl}>
                {(fp) => (
                  <Select
                    {...fp}
                    value={String(ttl)}
                    onChange={(v) => setTtl(Number(v))}
                    disabled={pending}
                    options={s.expiryOptions.map((o) => ({ value: String(o.minutes), label: o.label }))}
                  />
                )}
              </Field>
              <Field label={s.label} info={s.labelInfo} error={labelError ?? serverLabel} optional>
                {(fp) => (
                  <Input
                    {...fp}
                    value={label}
                    placeholder={group ? autoLabel(group.name, now) : undefined}
                    onChange={(e) => {
                      setLabel(e.target.value);
                      setLabelError(null);
                    }}
                    autoComplete="off"
                    maxLength={200}
                    disabled={pending}
                  />
                )}
              </Field>
            </div>
          </div>
        </details>

        {devicesFull ? <InlineNotice tone="warning" title={s.planFull} /> : null}
        <FormError error={error} fields={["uses", "ttlMinutes", "label"]} describe={(e) => enrollErrorMessage(e, p)} />
        {codeLimit ? (
          <div>
            <Button variant="ghost" className="dash-btn--sm" onClick={onSeeCodes}>
              {s.seeCodes}
            </Button>
          </div>
        ) : null}

        <div className="addpc-form__foot">
          <p className="addpc-form__summary" aria-live="polite">
            {s.summary(uses, ttlLabel)}
            {codeUsage ? <span> {codeUsage}</span> : null}
          </p>
          <Button type="submit" className="addpc-primary" disabled={pending || !group} aria-busy={pending}>
            <IconKey aria-hidden="true" />
            {pending ? s.creating : s.create}
          </Button>
        </div>
      </form>
    </WizardFrame>
  );
}
