import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useLockdownSync, useLockdownView, useSaveLockdown } from "../data/lockdown";
import type { LayerMode, LockdownSettings, LockdownSync, LockdownView, QueryState } from "../data/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FormError } from "../components/FormError";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { useCan } from "../lib/member";
import { useToast } from "../lib/toast";
import { useNow } from "../lib/useNow";
import { AdvancedSettings } from "./lockdown/AdvancedSettings";
import { AllowedPrograms } from "./lockdown/AllowedPrograms";
import { applyPreset, fieldChanged, presetOf, type PresetId } from "./lockdown/presets";
import { PresetPicker } from "./lockdown/PresetPicker";
import { ProgramMode } from "./lockdown/ProgramMode";
import { ReviewCard } from "./lockdown/ReviewCard";
import { SaveBar } from "./lockdown/SaveBar";
import { changeLabels, changedLayers, lockoutDraftOf, lockoutProblems, sameSettings, setProgramMode, settingsOf, type LockoutDraft } from "./lockdown/rules";
import { SyncCard } from "./lockdown/SyncCard";
import { lockdownErrorMessage, lockdownStrings as s } from "./lockdown/strings";
import "./lockdown/lockdown.css";

const DAY = 24 * 60 * 60 * 1000;

/**
 * `/groups/:id/lockdown` (UI pass, `docs/plans/ui-pass/lockdown.md`): a protection level, one "Program blocking" choice and, under
 * Advanced, every individual setting, with one Save in a bar at the bottom. `lockdown:groupView` is the form's query; `lockdown:groupSync`
 * ("PCs up to date") is a query of its own, so a PC's report never re-runs the form. Switching to Block asks first and says how many
 * programs are still waiting for review. Admins change, viewers read.
 */
export default function Lockdown() {
  const { id = "" } = useParams();
  const view = useLockdownView(id);
  const sync = useLockdownSync(id);
  const back = { to: `/groups/${id}`, label: s.back };
  const [formKey, setFormKey] = useState(0);
  // After a save the "Your PCs" card says "Sending" until every PC that can has the new settings.
  const [sending, setSending] = useState(false);
  return (
    <div className="dash-page lk-page">
      {view.status !== "ready" ? <PageHeader title={view.status === "loading" ? s.loadingTitle : s.title} back={back} /> : null}
      <QueryRegion state={view} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
        {(v) => (
          <>
            <PageHeader back={back} title={<span className="dash-wrap">{s.titleFor(v.groupName)}</span>} lead={s.lead} />
            {/* A fresh form (the saved values again) after Reload on a stale edit. */}
            <Form key={formKey} groupId={id} v={v} sync={sync} sending={sending} onSaved={() => setSending(true)} onReload={() => setFormKey((k) => k + 1)} />
          </>
        )}
      </QueryRegion>
    </div>
  );
}

function Form({
  groupId,
  v,
  sync,
  sending,
  onSaved,
  onReload,
}: {
  groupId: string;
  v: LockdownView;
  sync: QueryState<LockdownSync>;
  sending: boolean;
  onSaved: () => void;
  onReload: () => void;
}) {
  const save = useSaveLockdown();
  const canAct = useCan("admin");
  const toast = useToast();
  const now = useNow(60 * 60_000);
  const formRef = useRef<HTMLFormElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<LockdownSettings>(v.settings);
  const [lockout, setLockout] = useState<LockoutDraft>(() => lockoutDraftOf(v.settings));
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [focusError, setFocusError] = useState(0);
  // What the group has saved: the form's starting point, and the new one after a save (so the bar goes away at once).
  const [saved, setSaved] = useState(v.settings);
  // The revision this form started from: a save by someone else in between is a stale edit, not a silent overwrite.
  const [revision, setRevision] = useState(v.revision);
  const off = !canAct || pending;

  const problems = lockoutProblems(lockout);
  const invalid = problems.threshold || problems.duration || problems.window;
  const next = settingsOf(draft, lockout);
  const changed = !sameSettings(next, saved);
  // A wrong lockout number is an unsaved edit too (the saved lockout stands in the settings until it is right), so the bar stays to say so.
  const dirty = changed || invalid;
  const enforcing = changedLayers(saved, next).filter((l) => l.to === "enforce");
  const managedOn = next.wifiManagedOnly && !saved.wifiManagedOnly;
  const match = presetOf(next);
  const labels = changeLabels(saved, next);
  const trialDays = v.auditSince === null ? 0 : Math.floor((now - v.auditSince) / DAY);
  const adminTilesPending = sync.status === "ready" ? sync.data.adminTilesPending : 0;

  // After a failed Save click the Advanced section is open and the first wrong field has the focus.
  useEffect(() => {
    if (focusError === 0) return;
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    field?.focus();
    field?.scrollIntoView?.({ block: "center" });
  }, [focusError]);

  function showAdvanced() {
    setAdvancedOpen(true);
    advancedRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }

  function pickPreset(id: PresetId) {
    const applied = applyPreset(draft, id);
    setDraft(applied);
    setLockout(lockoutDraftOf(applied));
    setTouched(false);
  }

  const pickMode = (m: LayerMode) => setDraft((d) => setProgramMode(d, m));

  async function send(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const r = await save({ groupId, settings: next, expectedRevision: revision });
      setRevision(r.revision);
      setSaved(next);
      onSaved();
      toast(sync.status === "ready" && sync.data.ringsOn ? s.savedRings : s.saved);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  function submit() {
    setTouched(true);
    if (pending) return;
    if (invalid) {
      setAdvancedOpen(true);
      setFocusError((n) => n + 1);
      return;
    }
    if (!changed) return;
    if (enforcing.length > 0 || managedOn) setConfirming(true);
    else void send();
  }

  function undo() {
    setDraft(saved);
    setLockout(lockoutDraftOf(saved));
    setTouched(false);
    setError(null);
  }

  return (
    <>
      <form
        ref={formRef}
        className="lk"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {canAct ? null : <InlineNotice tone="neutral" title={s.readOnly} />}
        <div className="lk-layout">
          <div className="lk-main">
            <PresetPicker className="lk-level" settings={next} onPick={pickPreset} onShowChanges={showAdvanced} disabled={off} />
            <ProgramMode className="lk-mode" settings={draft} trialDays={trialDays} onPick={pickMode} onShowChecks={showAdvanced} disabled={off} />
            <div ref={advancedRef} className="lk-adv-anchor">
              <AdvancedSettings
                className="lk-advwrap"
                draft={draft}
                lockout={lockout}
                problems={problems}
                touched={touched}
                disabled={off}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                changedCount={match.id === "custom" ? match.changes.length : 0}
                isChanged={(path) => match.id === "custom" && fieldChanged(next, match.nearest, path)}
                patch={setDraft}
                setLockout={setLockout}
                adminTilesPending={adminTilesPending}
              />
            </div>
          </div>
          <div className="lk-aside">
            <SyncCard groupId={groupId} sync={sync} sending={sending} />
            <ReviewCard groupId={groupId} count={v.openFindings} more={v.openFindingsMore} />
            <AllowedPrograms exceptions={v.exceptions} truncated={v.exceptionsTruncated} />
          </div>
        </div>
        {canAct && (dirty || error) ? (
          <SaveBar count={Math.max(labels.count, 1)} labels={labels.labels} more={labels.more} pending={pending} onUndo={undo} error={<FormError error={error} onReload={onReload} describe={lockdownErrorMessage} />} />
        ) : null}
      </form>

      <ConfirmDialog
        open={confirming}
        title={s.enforceTitle}
        confirmLabel={s.enforceConfirm}
        body={
          <>
            {enforcing.length > 0 ? (
              <>
                <p>{s.enforceIntro}</p>
                <p>{s.enforceFindings(v.openFindings, v.openFindingsMore)}</p>
                {v.openFindings > 0 ? (
                  <p>
                    <Link to={`/lockdown/findings?group=${encodeURIComponent(groupId)}`}>{s.enforceReview}</Link>
                  </p>
                ) : null}
                {enforcing.some((l) => l.layer === "appControl") ? <p>{s.enforceAppControl}</p> : null}
                <p>{s.enforceAuditFirst}</p>
              </>
            ) : null}
            {managedOn ? <p>{s.managedConfirm}</p> : null}
          </>
        }
        // The dialog closes either way: an error is shown next to the form, where Reload is.
        onConfirm={send}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
