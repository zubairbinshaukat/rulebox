import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@rulebox/ui";
import IconAdd from "~icons/solar/add-circle-linear";
import IconMonitor from "~icons/solar/monitor-bold-duotone";
import { useGroupsScreen } from "../../data";
import { InlineNotice } from "../../components/Notice";
import { SkeletonBlock } from "../../components/Skeleton";
import { RegionError } from "../../components/Region";
import { CreateStep, type CodeSettings, type CreatedCode } from "./CreateStep";
import { ProgressPanel } from "./ProgressPanel";
import { enrollText as s } from "./strings";
import { WizardFrame } from "./WizardFrame";

export interface AddPcWizardProps {
  canAct: boolean;
  /** Focuses the list of codes (the plan limit message offers "See your codes"). */
  onSeeCodes: () => void;
}

/** What the wizard shows: the form, the progress of the code in `?watch=`, or the quiet card after "Done". */
type Phase = "create" | "idle";

/**
 * "Add a PC" (plan section 3): 1. Create a code, 2. Install on the PC, 3. Done. An admin lands in step 1 straight away; the default
 * group, one PC and one day make creating a code one click. The code lives only in this component's state. What survives a reload
 * is `?watch=<code row id>` (not secret): it brings back step 2 or 3 without the code. `?group=<id>` (the group page's "Add PCs")
 * preselects that group. The progress query runs only while a code is watched (`ProgressPanel` is the only caller).
 */
export function AddPcWizard({ canAct, onSeeCodes }: AddPcWizardProps) {
  const groups = useGroupsScreen();
  const [params, setParams] = useSearchParams();
  const watch = params.get("watch");
  const groupParam = params.get("group");

  const [phase, setPhase] = useState<Phase>(canAct ? "create" : "idle");
  const [created, setCreated] = useState<CreatedCode | null>(null);
  const [last, setLast] = useState<CodeSettings | null>(null);
  const [gone, setGone] = useState(false);
  // True once the person did something here: only then does a step's heading take the focus.
  const [touched, setTouched] = useState(false);

  const setWatch = useCallback(
    (id: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === null) next.delete("watch");
          else next.set("watch", id);
          next.delete("group");
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // The code belongs to its own `?watch`: any other address (Back, a typed link) drops it from memory. Between "created" and the address
  // catching up (the router may update a moment later) the code's own id counts as the watched one, so step 1 never flashes back.
  const active = watch ?? created?.tokenId ?? null;
  const mine = created !== null && created.tokenId === active ? created : null;
  const confirmed = useRef(false);
  useEffect(() => {
    if (created === null) {
      confirmed.current = false;
      return;
    }
    if (watch === created.tokenId) confirmed.current = true;
    else if (watch !== null || confirmed.current) setCreated(null);
  }, [created, watch]);
  // Arriving with an address that already names a code is not the person's doing: the heading takes the focus only after a change.
  const [firstWatch] = useState(watch);
  const onGone = useCallback(() => {
    setGone(true);
    setWatch(null);
  }, [setWatch]);

  const toCreate = () => {
    setTouched(true);
    setCreated(null);
    setGone(false);
    setWatch(null);
    setPhase("create");
  };
  const toIdle = () => {
    setTouched(true);
    setCreated(null);
    setGone(false);
    setWatch(null);
    setPhase("idle");
  };

  if (active !== null) {
    return (
      <ProgressPanel
        key={active}
        tokenId={active}
        code={mine}
        canAct={canAct}
        focus={touched || active !== firstWatch}
        onNewCode={toCreate}
        onAnother={toCreate}
        onDone={toIdle}
        onGone={onGone}
      />
    );
  }

  const notice = gone ? <InlineNotice tone="warning" title={s.gone} /> : null;

  if (phase === "idle" || !canAct) {
    return (
      <>
        {notice}
        <section className="dash-card addpc-idle dash-enter">
          <span className="addpc-idle__icon" aria-hidden="true">
            <IconMonitor />
          </span>
          {canAct ? (
            <>
              <div className="addpc-idle__text">
                <h2 className="addpc-idle__title">{s.idleTitle}</h2>
                <p className="addpc-idle__body">{s.idleBody}</p>
              </div>
              <Button className="addpc-primary" onClick={toCreate}>
                <IconAdd aria-hidden="true" />
                {s.idleAction}
              </Button>
            </>
          ) : (
            <div className="addpc-idle__text">
              <h2 className="addpc-idle__title">{s.title}</h2>
              <p className="addpc-idle__body">{s.viewerIdle}</p>
            </div>
          )}
        </section>
      </>
    );
  }

  if (groups.status !== "ready") {
    return (
      <WizardFrame step={1} heading={s.createHeading}>
        {groups.status === "error" ? <RegionError error={groups.error} onRetry={groups.retry} /> : <SkeletonBlock lines={4} />}
      </WizardFrame>
    );
  }

  return (
    <>
      {notice}
      <CreateStep
        groups={groups.data}
        groupParam={groupParam}
        initial={last}
        focus={touched}
        onSeeCodes={onSeeCodes}
        onCreated={(c) => {
          setTouched(true);
          setLast(c.settings);
          setCreated(c);
          setWatch(c.tokenId);
        }}
      />
    </>
  );
}
