import { useState } from "react";
import { Button, Pill } from "@rulebox/ui";
import { useGithubReleases, useRelease, useSetRelease } from "../../data/release";
import type { GithubRelease, GithubReleasesHandle, ReleaseInfo, ReleaseScreen } from "../../data/release/api";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { serverFieldError } from "../../components/serverField";
import { formatBytes, formatDate } from "../../lib/format";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { fieldsOf, releaseOf, sameRelease, type ReleaseFields, type ReleaseValue } from "./releaseRules";
import { updates as s } from "./strings";
import { CurrentRelease } from "./updates/CurrentRelease";
import { CustomBuild } from "./updates/CustomBuild";
import { ReleasePicker } from "./updates/ReleasePicker";
import { hasProblem, pickerView, problemsOf, sameFields } from "./updates/model";
import { defaultPick, fieldsOfGithub, isOnNewest, relationToCurrent, valueOfGithub, warningsOf, type PickWarning } from "./updates/pickRules";
import "./updates/updates.css";

const FIELDS = ["release.version", "release.url", "release.sha256", "release.sizeBytes"] as const;
const SERVER_KEY = { version: "release.version", url: "release.url", sha256: "release.sha256", size: "release.sizeBytes" } as const;

/**
 * Settings → Rulebox updates: `ruleboxRelease:get` (the target), `ruleboxRelease:githubReleases` (an Owner action, on open and on Refresh)
 * and `ruleboxRelease:set` (an Owner action with a fresh step-up, after one explicit confirmation).
 */
export default function UpdatesTab() {
  const release = useRelease();
  const isOwner = useCan("owner");
  // Started together with the target query; admins and viewers never call the action.
  const gh = useGithubReleases(isOwner);
  const [formKey, setFormKey] = useState(0);
  return (
    <QueryRegion state={release} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
      {(data) => <Updates key={formKey} data={data} gh={gh} isOwner={isOwner} onReload={() => setFormKey((k) => k + 1)} />}
    </QueryRegion>
  );
}

function Updates({ data, gh, isOwner, onReload }: { data: ReleaseScreen; gh: GithubReleasesHandle; isOwner: boolean; onReload: () => void }) {
  const set = useSetRelease();
  const toast = useToast();
  const current: ReleaseValue | null = data.release;
  const list = gh.state.status === "ready" && gh.state.data.status === "ok" ? gh.state.data.releases : null;

  // The revision this screen saves against, then the one the server answered.
  const [revision, setRevision] = useState(data.revision);
  // `undefined`: the owner has not chosen (the default pick is shown), `null`: nothing, a tag: that release.
  const [userPick, setUserPick] = useState<string | null | undefined>(undefined);
  // The fields of "your own build" once the owner edited one; until then they show the pick (or the current release).
  const [edited, setEdited] = useState<ReleaseFields | null>(null);
  const [advOpen, setAdvOpen] = useState<boolean | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);

  const custom = edited !== null && !sameFields(edited, fieldsOf(current));
  const selected: GithubRelease | null =
    custom || list === null
      ? null
      : userPick === undefined
        ? defaultPick(list, current)
        : (list.find((r) => r.tag === userPick && r.problem === null) ?? null);
  const fields: ReleaseFields = edited ?? (selected ? fieldsOfGithub(selected) : null) ?? fieldsOf(current);
  const problems = submitted ? problemsOf(fields) : {};
  const mode: "none" | "release" | "custom" = custom ? "custom" : selected ? "release" : "none";
  const serverProblem = (key: keyof ReleaseFields) => serverFieldError(error, SERVER_KEY[key], () => s.problems.serverRefused);
  const view = pickerView(gh.state);
  const advAuto = view === "empty" || view === "unavailable";
  const serverShown = (Object.keys(SERVER_KEY) as (keyof ReleaseFields)[]).some((k) => serverProblem(k) !== null);
  const advShown = (advOpen ?? advAuto) || hasProblem(problems) || serverShown;

  const pick = (r: GithubRelease) => {
    setUserPick(r.tag);
    setEdited(null);
    setSubmitted(false);
    setError(null);
  };
  const edit = (key: keyof ReleaseFields, value: string) => {
    setEdited({ ...fields, [key]: value });
    setUserPick(null);
    setError(null);
  };

  // What the owner is told before saving, for a release from the list or for a typed build.
  const typed = mode === "custom" && !hasProblem(problemsOf(fields)) ? releaseOf(fields) : null;
  const warnings: PickWarning[] = selected
    ? warningsOf(selected, current)
    : typed
      ? (["changed", "older", "sameVersionOtherBuild"] as const).filter((w) => relationToCurrent(typed, current) === w)
      : [];
  const changedInList =
    list?.some((r) => {
      const value = valueOfGithub(r);
      return value !== null && relationToCurrent(value, current) === "changed";
    }) ?? false;
  const target = selected ? selected.version : fields.version.trim();

  const start = () => {
    if (hasProblem(problemsOf(fields))) {
      setSubmitted(true);
      return;
    }
    setError(null);
    setConfirm(true);
  };

  const save = async () => {
    const next: ReleaseInfo = releaseOf(fields);
    if (sameRelease(next, current)) {
      toast(s.noChange);
      return;
    }
    setSaving(true);
    try {
      const r = await set({ expectedRevision: revision, release: next });
      setRevision(r.revision);
      setEdited(null);
      setUserPick(null);
      setSubmitted(false);
      setError(null);
      toast(s.saved(next.version));
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const stop = async () => {
    await set({ expectedRevision: revision, release: null });
    toast(s.cleared);
  };

  if (!isOwner) {
    return (
      <div className="upd upd--read">
        <CurrentRelease data={data} isOwner={false} changed={false} onStop={stop} />
        <InlineNotice tone="neutral" title={s.ownerOnly} />
      </div>
    );
  }

  const onNewest = mode === "none" && list !== null && isOnNewest(list, current);
  const selectedCard = (
    <div className="upd__selected" data-active={mode !== "none" || undefined}>
      <Card level={3} title={s.selectedTitle}>
        {mode === "none" ? (
          onNewest ? (
            <InlineNotice tone="success" title={s.onNewest} />
          ) : (
            <p className="dash-muted">{s.choose}</p>
          )
        ) : (
          <div className="upd-sel">
            <p className="upd-sel__name">
              <strong>{selected ? s.rulebox(selected.version) : s.ownBuild}</strong>
              {selected && selected.prerelease ? <Pill tone="warning">{s.testBuild}</Pill> : null}
              {selected && !selected.signed ? <Pill>{s.unsigned}</Pill> : null}
            </p>
            <p className="upd-sel__meta">
              {selected
                ? `${formatBytes(selected.msi?.sizeBytes ?? 0)} · ${formatDate(selected.publishedAt)}`
                : typed
                  ? `${s.rulebox(typed.version)} · ${formatBytes(typed.sizeBytes)}`
                  : null}
            </p>
            {warnings
              .filter((w): w is Exclude<PickWarning, "unsigned"> => w !== "unsigned")
              .map((w) => (
                <InlineNotice key={w} tone="warning" title={s.warnings[w]} />
              ))}
            <FormError error={error} onReload={onReload} fields={FIELDS} />
            <Button className="dash-btn--accent upd-sel__go" onClick={start} disabled={saving} aria-busy={saving}>
              {saving ? s.saving : s.mainAction(target)}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );

  return (
    <div className="upd">
      <div className="upd__main">
        <ReleasePicker gh={gh} current={current} selectedTag={selected?.tag ?? null} disabled={saving} onPick={pick} />
        <CustomBuild
          fields={fields}
          problems={problems}
          serverProblem={serverProblem}
          disabled={saving}
          open={advShown}
          onToggle={setAdvOpen}
          onEdit={edit}
        />
      </div>
      <div className="upd__aside">
        <CurrentRelease data={{ ...data, revision }} isOwner changed={changedInList} onStop={stop} />
        {mode !== "none" || view === "list" ? selectedCard : null}
      </div>
      <ConfirmDialog
        open={confirm}
        title={s.confirmTitle(target)}
        body={s.confirmBody}
        confirmLabel={s.confirmButton}
        onConfirm={save}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}
