import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button, InfoTip, ProgressBar } from "@rulebox/ui";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import IconQr from "~icons/solar/qr-code-linear";
import IconLink from "~icons/solar/link-round-linear";
import IconMonitor from "~icons/solar/monitor-bold-duotone";
import IconCheck from "~icons/solar/check-read-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useEnrollmentProgress } from "../../data/enrollment";
import type { EnrollmentPc, EnrollmentProgress, Id } from "../../data/types";
import { InlineNotice } from "../../components/Notice";
import { RegionError } from "../../components/Region";
import { RelativeTime } from "../../components/RelativeTime";
import { SkeletonBlock } from "../../components/Skeleton";
import { errorCodeOf } from "../../lib/errors";
import { downloadUrl } from "../../lib/links";
import { useNow } from "../../lib/useNow";
import { CodeBlocks, CommandLine, CopyLabel } from "./CodeParts";
import type { CreatedCode } from "./CreateStep";
import { PC_STAGES, pcStage, progressState, silentCommand, untilText, type PcStage } from "./model";
import { QrDialog } from "./QrDialog";
import { enrollText as s } from "./strings";
import { useCopy } from "./useCopy";
import { HowTo, WizardFrame, type WizardStep } from "./WizardFrame";

export interface ProgressPanelProps {
  tokenId: Id;
  /** The code, while this screen still holds it (just created). Null after a reload or "See progress": it is never shown again. */
  code: CreatedCode | null;
  /** Admins and owners can make another code; viewers only watch. */
  canAct: boolean;
  focus: boolean;
  /** "Create a new code": step 1 again with the same settings. */
  onNewCode: () => void;
  /** "Add another PC": step 1 again. */
  onAnother: () => void;
  onDone: () => void;
  /** The code is not this organization's (or was deleted): the screen drops `?watch`. */
  onGone: () => void;
}

/**
 * Steps 2 and 3. The only place that subscribes to `enrollmentCodes:progress` (one query, a few dozen small reads, re-run only when the
 * code, one of its PCs or the download changes), and it is mounted only while a code is being watched. Step 2 shows the code and waits;
 * the first PC that joins turns it into step 3 by itself.
 */
export function ProgressPanel(props: ProgressPanelProps) {
  const progress = useEnrollmentProgress(props.tokenId);
  const gone = progress.status === "error" && errorCodeOf(progress.error) === "not_found";
  const { onGone } = props;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  if (progress.status === "ready") return <Ready p={progress.data} {...props} />;
  return (
    <WizardFrame step={2} heading={s.installHeading} focus={props.focus}>
      {progress.status === "error" ? gone ? null : <RegionError error={progress.error} onRetry={progress.retry} /> : <SkeletonBlock lines={4} />}
    </WizardFrame>
  );
}

function Ready({ p, code, canAct, focus, onNewCode, onAnother, onDone }: ProgressPanelProps & { p: EnrollmentProgress }) {
  const now = useNow(30_000);
  const state = progressState(p, now);
  const step: WizardStep = p.joined > 0 ? 3 : 2;
  const ready = p.pcs.length > 0 && p.pcs.every((pc) => pcStage(pc) === "ready") && p.pcs.length === p.joined;
  const heading = step === 2 ? s.installHeading : s.joinedHeading(p.joined, ready);
  const summary = s.stepSummary(p.groupName, p.usesTotal);
  // Only a code that still works, and that this screen still holds, can be shown.
  const shown = code !== null && state === "active" ? code : null;

  return (
    <WizardFrame step={step} heading={heading} summary={summary} focus={focus} announce={step === 3 ? heading : undefined}>
      {step === 2 ? (
        <InstallBody p={p} code={shown} state={state} canAct={canAct} onNewCode={onNewCode} />
      ) : (
        <JoinedBody p={p} code={shown} state={state} canAct={canAct} onNewCode={onNewCode} onAnother={onAnother} onDone={onDone} />
      )}
    </WizardFrame>
  );
}

// ---------------------------------------------------------------- step 2

function InstallBody({
  p,
  code,
  state,
  canAct,
  onNewCode,
}: {
  p: EnrollmentProgress;
  code: CreatedCode | null;
  state: ReturnType<typeof progressState>;
  canAct: boolean;
  onNewCode: () => void;
}) {
  const now = useNow(30_000);
  if (state === "revoked" || state === "expired") {
    return <Closed message={state === "revoked" ? s.revokedNow : s.expired} canAct={canAct} onNewCode={onNewCode} />;
  }
  return (
    <div className="addpc-install">
      {code ? (
        <>
          <CodePanel code={code.code} download={p.download} />
          <p className="addpc-works">{s.worksFor(code.uses, untilText(code.expiresAt, now))}</p>
          <HowTo lines={s.how} />
          <p className="addpc-needs">
            <span>{s.needsLabel}</span>
            <InfoTip label={`About ${s.needsLabel.toLowerCase()}`}>{s.needsInfo}</InfoTip>
          </p>
          <details className="dash-advanced">
            <summary>{s.silentTitle}</summary>
            <div className="dash-advanced__body">
              <CommandLine label={s.silentMsi} text={silentCommand(code.code, p.download?.version).msi} />
              <CommandLine label={s.silentCli} text={silentCommand(code.code, p.download?.version).cli} />
              <p className="addpc-note">{s.silentWarn}</p>
            </div>
          </details>
        </>
      ) : (
        <InlineNotice tone="neutral" title={s.hiddenNow} />
      )}
      <Waiting />
    </div>
  );
}

/** The code in blocks, and the three ways to get it (and the installer) to the PC. */
function CodePanel({ code, download }: { code: string; download: EnrollmentProgress["download"] }) {
  const blocks = useRef<HTMLParagraphElement>(null);
  const link = useRef<HTMLSpanElement>(null);
  const url = downloadUrl(download);
  const codeCopy = useCopy(code, blocks);
  const linkCopy = useCopy(url, link);
  const [qr, setQr] = useState(false);
  return (
    <div className="addpc-code">
      <div className="addpc-code__panel">
        <div className="addpc-code__head">
          <span className="addpc-code__title">{s.codeTitle}</span>
          <InfoTip label={`About ${s.codeTitle.toLowerCase()}`}>
            {s.codeOnceInfo} {s.codeCaseInfo}
          </InfoTip>
        </div>
        <CodeBlocks code={code} innerRef={blocks} />
        <p className="addpc-code__manual" role="status" aria-live="polite">
          {codeCopy.status === "manual" ? s.copyManual : codeCopy.status === "copied" ? <span className="dash-sr">{s.copied}</span> : null}
        </p>
      </div>
      <div className="addpc-actions">
        <Button className="addpc-primary addpc-copy" onClick={() => void codeCopy.copy()}>
          <CopyLabel status={codeCopy.status} />
        </Button>
        <a className="rb-btn rb-btn--ghost addpc-download" href={url} target="_blank" rel="noopener noreferrer">
          <IconDownload aria-hidden="true" />
          {s.download}
        </a>
        <div className="addpc-actions__more">
          <Button variant="ghost" className="dash-btn--sm" onClick={() => setQr(true)}>
            <IconQr aria-hidden="true" />
            {s.qr}
          </Button>
          <Button variant="ghost" className="dash-btn--sm" onClick={() => void linkCopy.copy()}>
            {linkCopy.status === "copied" ? <IconCheck aria-hidden="true" /> : <IconLink aria-hidden="true" />}
            {linkCopy.status === "copied" ? s.linkCopied : s.copyLink}
          </Button>
        </div>
        <span ref={link} className="dash-sr" translate="no" aria-hidden="true">
          {url}
        </span>
        {linkCopy.status === "manual" ? (
          <p className="addpc-code__manual" role="status">
            {s.copyManual}
          </p>
        ) : null}
      </div>
      <QrDialog open={qr} code={code} onClose={() => setQr(false)} />
    </div>
  );
}

function Waiting() {
  return (
    <div className="addpc-wait" role="status">
      <span className="addpc-pulse" aria-hidden="true" />
      <div>
        <p className="addpc-wait__title">{s.waiting}</p>
        <p className="addpc-wait__sub">{s.waitingSub}</p>
      </div>
    </div>
  );
}

function Closed({ message, canAct, onNewCode }: { message: string; canAct: boolean; onNewCode: () => void }) {
  return (
    <InlineNotice
      tone="warning"
      title={message}
      action={
        canAct ? (
          <Button variant="ghost" className="dash-btn--sm" onClick={onNewCode}>
            {s.newCode}
          </Button>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------- step 3

function JoinedBody({
  p,
  code,
  state,
  canAct,
  onNewCode,
  onAnother,
  onDone,
}: {
  p: EnrollmentProgress;
  code: CreatedCode | null;
  state: ReturnType<typeof progressState>;
  canAct: boolean;
  onNewCode: () => void;
  onAnother: () => void;
  onDone: () => void;
}) {
  const more = Math.max(0, p.joined - p.pcs.length);
  const severalPcs = p.usesTotal > 1;
  return (
    <div className="addpc-joined">
      {severalPcs ? (
        <div className="addpc-joined__bar">
          <ProgressBar value={Math.min(100, (p.joined / p.usesTotal) * 100)} label={s.joinedOf(p.joined, p.usesTotal)} name={s.joinedOf(p.joined, p.usesTotal)} />
        </div>
      ) : null}

      {state === "usedUp" && severalPcs ? <p className="addpc-note addpc-note--ok">{s.allJoined}</p> : null}
      {(state === "revoked" || state === "expired") && p.usesLeft > 0 ? (
        <Closed message={state === "revoked" ? s.revokedNow : s.expired} canAct={canAct} onNewCode={onNewCode} />
      ) : null}
      {code && state === "active" && p.usesLeft > 0 ? <NextPc code={code} left={p.usesLeft} /> : null}

      <ul className="addpc-pcs" aria-label={s.steps.done}>
        {p.pcs.map((pc) => (
          <PcRow key={pc._id} pc={pc} />
        ))}
      </ul>
      {more > 0 ? (
        <p className="addpc-more">
          <Link className="dash-link" to="/devices">
            {s.morePcs(more)}
          </Link>
        </p>
      ) : null}

      <div className="addpc-end">
        {canAct ? (
          <Button className="addpc-primary" onClick={onAnother}>
            <IconAdd aria-hidden="true" />
            {s.another}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onDone}>
          {s.done}
        </Button>
      </div>
    </div>
  );
}

/** The code is still good for more PCs: a small strip with Copy, so the next PC does not need a new one. */
function NextPc({ code, left }: { code: CreatedCode; left: number }) {
  const blocks = useRef<HTMLParagraphElement>(null);
  const { status, copy } = useCopy(code.code, blocks);
  return (
    <div className="addpc-next">
      <p className="addpc-next__text">{s.stillWorks(left)}</p>
      <div className="addpc-next__row">
        <CodeBlocks code={code.code} compact innerRef={blocks} />
        <Button variant="ghost" className="dash-btn--sm" onClick={() => void copy()}>
          <CopyLabel status={status} />
        </Button>
      </div>
      {status === "manual" ? (
        <p className="addpc-code__manual" role="status">
          {s.copyManual}
        </p>
      ) : null}
    </div>
  );
}

function PcRow({ pc }: { pc: EnrollmentPc }) {
  const stage = pcStage(pc);
  return (
    <li className="addpc-pc dash-enter" data-stage={stage}>
      <div className="addpc-pc__head">
        <span className="addpc-pc__icon" aria-hidden="true">
          <IconMonitor />
        </span>
        <div className="addpc-pc__id">
          <p className="addpc-pc__name" title={pc.name}>
            {pc.name}
          </p>
          <p className="addpc-pc__meta">
            {s.joinedAgo} <RelativeTime ms={pc.enrolledAt} />
            {stage === "joined" ? <span className="addpc-pc__muted"> · {s.notOnlineYet}</span> : null}
          </p>
        </div>
        <Link className="rb-btn rb-btn--ghost dash-btn--sm addpc-pc__open" to={`/devices/${pc._id}`} aria-label={`${s.openPc}: ${pc.name}`}>
          {s.openPc}
        </Link>
      </div>
      {stage === "needsAttention" ? (
        <Link className="addpc-attention" to={`/devices/${pc._id}`}>
          <IconWarn aria-hidden="true" />
          {s.stages.needsAttention}
        </Link>
      ) : (
        <StageTrack stage={stage} name={pc.name} />
      )}
    </li>
  );
}

/** Joined, Online, Setting up, Ready: the stages already passed are ticked, the one it is at is marked. Colour is never the only sign. */
function StageTrack({ stage, name }: { stage: Exclude<PcStage, "needsAttention">; name: string }) {
  const at = PC_STAGES.indexOf(stage);
  return (
    <ol className="addpc-stages" aria-label={s.stagesLabel(name, s.stages[stage])}>
      {PC_STAGES.map((st, i) => {
        const state = stage === "ready" || i < at ? "done" : i === at ? "current" : "todo";
        return (
          <li key={st} className="addpc-stage" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="addpc-stage__bar" aria-hidden="true" />
            <span className="addpc-stage__label">
              {state === "done" ? <IconCheck aria-hidden="true" /> : null}
              <span>{s.stages[st]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
