import { useMemo, useState } from "react";
import { Button, Checkbox, Input, SearchSelect, Select, type SelectOption } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import { useAllowFinding, useAllowOptions } from "../../data/lockdown";
import { MAX_ALLOW_GROUPS, MAX_EXCEPTION_REASON, type AllowOptions, type ExceptionKind, type FindingRow } from "../../data/types";
import { Field, FieldSet } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { allowKinds, folderProblem } from "./rules";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { findingsStrings as s, lockdownErrorMessage } from "./strings";

const KINDS: readonly ExceptionKind[] = ["publisher", "hash", "path"];
const NONE: AllowOptions = { groups: [], apps: [] };
/** More groups than this get a box to find one by name. */
const GROUP_FILTER_FROM = 8;

/** The folder a "by folder" rule starts from: the root of the folder the program was found in (the person adds the rest). */
function folderRoot(finding: FindingRow): string {
  return finding.folderClass === "rulebox" ? "{RuleboxApps}\\" : finding.folderClass === "programFiles" ? "{ProgramFiles}\\" : "";
}

/**
 * "Allow" (UI pass): the person only picks WHERE the program is allowed. How it is recognised is chosen for them (publisher, then the
 * exact version, then a folder: `allowKinds` lists them best first) and said in one sentence; changing it, the folder, the app it belongs
 * to and the note are under "Advanced". The group is preselected: the one from `?group=` or the only group. `lockdown:allowOptions`
 * (the group and app pickers) is subscribed only while this dialog is open.
 */
export function AllowDialog({ finding, defaultGroupId, onClose }: { finding: FindingRow | null; defaultGroupId: string | null; onClose: () => void }) {
  if (finding === null) return null;
  return <Inner key={finding._id} finding={finding} defaultGroupId={defaultGroupId} onClose={onClose} />;
}

function Inner({ finding, defaultGroupId, onClose }: { finding: FindingRow; defaultGroupId: string | null; onClose: () => void }) {
  const allow = useAllowFinding();
  const options = useAllowOptions();
  const toast = useToast();
  const possible = allowKinds(finding);
  const [kind, setKind] = useState<ExceptionKind | null>(possible[0] ?? null);
  const [folder, setFolder] = useState(() => folderRoot(finding));
  // null = the person has not touched the groups: the preselected one stands.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [filter, setFilter] = useState("");
  const [appId, setAppId] = useState("");
  const [reason, setReason] = useState("");
  const [advanced, setAdvanced] = useState(() => possible[0] === "path");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const groups = options.status === "ready" ? options.data.groups : NONE.groups;
  const apps = options.status === "ready" ? options.data.apps : NONE.apps;
  const only = groups.length === 1 ? groups[0]! : null;
  const preselected = useMemo<ReadonlySet<string>>(() => {
    if (only) return new Set([only._id]);
    return defaultGroupId !== null && groups.some((g) => g._id === defaultGroupId) ? new Set([defaultGroupId]) : new Set<string>();
  }, [only, defaultGroupId, groups]);
  const groupIds = picked ?? preselected;
  const shown = filter.trim() === "" ? groups : groups.filter((g) => g.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const badFolder = kind === "path" && folderProblem(folder);
  const noGroup = groupIds.size === 0;
  const tooMany = groupIds.size > MAX_ALLOW_GROUPS;
  const badReason = reason.trim().length > MAX_EXCEPTION_REASON;

  function submit() {
    setTouched(true);
    if (kind === null || badFolder || noGroup || tooMany || badReason || pending) {
      if (badFolder || badReason) setAdvanced(true);
      return;
    }
    setPending(true);
    setError(null);
    allow({
      findingId: finding._id,
      kind,
      ...(kind === "path" ? { folder: folder.trim() } : {}),
      groupIds: [...groupIds],
      ...(appId ? { appId } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }).then(
      (done) => {
        toast(s.allowed(done.added));
        onClose();
      },
      (e) => {
        setPending(false);
        setError(e);
      },
    );
  }

  const why = kind === null ? null : kind === "publisher" ? s.recognisedBy.publisher(finding.signer ?? "") : s.recognisedBy[kind];
  const kindOptions: SelectOption[] = KINDS.map((k) => ({ value: k, label: s.kinds[k], disabled: !possible.includes(k), hint: possible.includes(k) ? undefined : s.kindUnavailable[k] }));
  const appOptions: SelectOption[] = [{ value: "", label: s.appNone }, ...apps.map((a) => ({ value: a._id, label: a.name }))];

  return (
    <Modal
      open
      wide
      title={s.allowTitle(finding.fileName)}
      onClose={() => !pending && onClose()}
      onSubmit={submit}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" disabled={pending || kind === null} aria-busy={pending}>
            {pending ? s.allowing : s.allowConfirm}
          </Button>
        </>
      }
    >
      <div className="dash-form">
        <p className="dash-muted">{s.allowLead}</p>
        {possible.length === 0 ? <InlineNotice tone="warning" title={s.appControlNote} detail={s.appControlInfo} /> : null}
        {why ? (
          <p className="lk-allow__why" data-tone={kind === "hash" ? "warning" : undefined}>
            {kind === "hash" ? <IconWarn aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
            <span>{why}</span>
          </p>
        ) : null}

        {only ? (
          <p className="lk-allow__one">{s.groupsOne(only.name)}</p>
        ) : (
          <FieldSet legend={s.groups} hint={groups.length > 1 ? s.groupsHint : undefined} error={touched && noGroup ? s.groupsProblem : tooMany ? s.groupsTooMany : null}>
            {options.status === "ready" && groups.length === 0 ? <p className="dash-muted">{s.noGroups}</p> : null}
            {groups.length > GROUP_FILTER_FROM ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={s.groupsFilter} aria-label={s.groupsFilter} autoComplete="off" /> : null}
            <div className="lk-allow__groups">
              {shown.map((g) => (
                <Checkbox
                  key={g._id}
                  label={g.name}
                  checked={groupIds.has(g._id)}
                  disabled={pending}
                  onChange={(e) =>
                    setPicked(() => {
                      const next = new Set(groupIds);
                      if (e.target.checked) next.add(g._id);
                      else next.delete(g._id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </FieldSet>
        )}
        {only && touched && noGroup ? <p className="dash-field__error">{s.groupsProblem}</p> : null}

        <details className="dash-advanced lk-allow__adv" open={advanced}>
          <summary
            onClick={(e) => {
              e.preventDefault();
              setAdvanced((a) => !a);
            }}
          >
            {s.advanced}
          </summary>
          {advanced ? (
            <div className="dash-advanced__body">
              <Field label={s.ruleKind}>
                {(p) => <Select {...p} value={kind ?? ""} options={kindOptions} disabled={pending || possible.length === 0} onChange={(k) => setKind(k as ExceptionKind)} />}
              </Field>
              {kind === "path" ? (
                <Field label={s.folder} hint={s.folderHint} error={touched && badFolder ? s.folderProblem : null} required>
                  {(p) => <Input {...p} value={folder} autoComplete="off" spellCheck={false} onChange={(e) => setFolder(e.target.value)} />}
                </Field>
              ) : null}
              <Field label={s.app} optional>
                {(p) => <SearchSelect {...p} value={appId} options={appOptions} disabled={pending} searchPlaceholder={s.appSearch} emptyText={s.appEmpty} onChange={setAppId} />}
              </Field>
              <Field label={s.reason} error={touched && badReason ? s.reasonProblem : null} optional>
                {(p) => <Input {...p} value={reason} autoComplete="off" disabled={pending} onChange={(e) => setReason(e.target.value)} />}
              </Field>
            </div>
          ) : null}
        </details>
        {options.status === "error" ? <FormError error={options.error} /> : null}
        <FormError error={error} describe={lockdownErrorMessage} />
      </div>
    </Modal>
  );
}
