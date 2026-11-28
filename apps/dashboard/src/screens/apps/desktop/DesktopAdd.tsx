import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@rulebox/ui";
import { useAppByWinget, useCreateDesktopApp, useResolveWinget } from "../../../data";
import type { WingetResolved } from "../../../data/types";
import { AppGlyph } from "../../../components/AppGlyph";
import { FormError } from "../../../components/FormError";
import { InlineNotice } from "../../../components/Notice";
import { PageHeader } from "../../../components/PageHeader";
import { SkeletonBlock } from "../../../components/Skeleton";
import { messageFor, registerDetailSentences, toAppError } from "../../../lib/errors";
import { useCan } from "../../../lib/member";
import { wingetRefusalKind } from "../../../lib/apps/silentMode";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../../lib/screenStrings/appEdit";
import { installRefusalStrings } from "../../../lib/screenStrings/installRefusals";
import { strings } from "../../../lib/strings";
import { useForm } from "../../../lib/useForm";
import { useToast } from "../../../lib/toast";
import * as v from "../../../lib/validate";
import { desktopSpec, initialValues, validateValues, type FormValues } from "../appForm";
import { galleryApp, type GalleryApp } from "../gallery/catalog";
import { DesktopBody } from "./DesktopBody";
import { useDisclosures } from "./disclosures";
import { InstallerCheck } from "./InstallerCheck";
import { blankDesktopDetail, checkedBefore, linesOf, wingetFill } from "./model";
import { useInstallerCheck } from "./useInstallerCheck";
import "../apps.css";

registerDetailSentences(installRefusalStrings);

const t = appAddStrings;
const review = t.review;

type Mode = "winget" | "installer" | "portable" | "preinstalled";
type Plan = { mode: Mode; entry?: GalleryApp; wingetId?: string } | { mode: "missing" } | { mode: "start" };

/** What the address asks for: a popular app (`gallery`), a winget id (`winget`) or another way (`source`). */
function planOf(params: URLSearchParams): Plan {
  const gallery = params.get("gallery");
  const winget = params.get("winget");
  const source = params.get("source");
  if (gallery !== null) {
    const entry = galleryApp(gallery);
    if (!entry || entry.kind !== "desktop") return { mode: "missing" };
    return entry.source === "preinstalled" ? { mode: "preinstalled", entry } : { mode: "winget", entry, wingetId: entry.wingetId };
  }
  if (winget !== null) return v.wingetId(winget.trim()) === null ? { mode: "winget", wingetId: winget.trim() } : { mode: "missing" };
  if (source === "installer" || source === "portable" || source === "preinstalled") return { mode: source };
  return { mode: "start" };
}

/** `/apps/new?kind=desktop&gallery=<key>|winget=<id>|source=installer|portable|preinstalled`: the Windows app review. */
export default function DesktopAdd() {
  const [params] = useSearchParams();
  const plan = planOf(params);
  if (plan.mode === "start") return <Navigate to="/apps/new" replace />;
  if (plan.mode === "missing") return <Navigate to="/apps/new?missing=1" replace />;
  const key = `${plan.mode}:${plan.entry?.key ?? ""}:${plan.wingetId ?? ""}`;
  return <Add key={key} mode={plan.mode} entry={plan.entry} wingetId={plan.wingetId} />;
}

type Phase = { name: "idle" } | { name: "loading" } | { name: "ready" } | { name: "unsupported"; kind: ReturnType<typeof wingetRefusalKind> } | { name: "unreachable" } | { name: "limited" } | { name: "error"; text: string };

function startValues(mode: Mode, entry: GalleryApp | undefined, wingetId: string | undefined): FormValues {
  const base = initialValues(blankDesktopDetail(), "desktop");
  switch (mode) {
    case "winget":
      return { ...base, source: "winget", wingetId: wingetId ?? "", name: entry?.name ?? "", hue: entry?.hue, exe: entry?.exe ?? base.exe };
    case "portable":
      return { ...base, source: "portable", exe: "{RuleboxApps}\\{AppId}\\app.exe", removeWhenUnassigned: true };
    case "preinstalled":
      return { ...base, source: "preinstalled", name: entry?.name ?? "", hue: entry?.hue, exe: entry?.exe ?? base.exe };
    default:
      return { ...base, source: "exe" };
  }
}

function Add({ mode, entry, wingetId }: { mode: Mode; entry: GalleryApp | undefined; wingetId: string | undefined }) {
  const canAct = useCan("admin");
  const navigate = useNavigate();
  const toast = useToast();
  const createDesktop = useCreateDesktopApp();
  const resolve = useResolveWinget();
  const form = useRef<HTMLFormElement>(null);
  const f = useForm<FormValues>(useMemo(() => startValues(mode, entry, wingetId), [mode, entry, wingetId]), (x) => validateValues("desktop", x));
  const check = useInstallerCheck(f);
  const x = f.values;
  const duplicate = useAppByWinget(mode === "winget" && canAct && wingetId ? wingetId : "skip");
  const disclosures = useDisclosures(f.errors as Record<string, string | undefined>, false);

  // ---- the winget look-up, once per page open (and again on "Try again")
  const [phase, setPhase] = useState<Phase>(mode === "winget" && canAct ? { name: "loading" } : { name: "idle" });
  const [attempt, setAttempt] = useState(0);
  const started = useRef<number | null>(null);
  const mounted = useRef(false);
  const latest = useRef(x);
  useEffect(() => {
    latest.current = x;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (mode !== "winget" || !canAct || !wingetId || started.current === attempt) return;
    started.current = attempt;
    setPhase({ name: "loading" });
    resolve({ packageId: wingetId }).then(
      (r: WingetResolved) => {
        if (!mounted.current) return;
        const patch = wingetFill(r, entry, latest.current);
        for (const k of Object.keys(patch) as (keyof FormValues)[]) f.set(k, patch[k] as never);
        setPhase({ name: "ready" });
      },
      (e: unknown) => {
        if (!mounted.current) return;
        const err = toAppError(e);
        if (err?.code === "winget_unsupported") setPhase({ name: "unsupported", kind: wingetRefusalKind(err.detail) });
        else if (err?.code === "winget_unreachable") setPhase({ name: "unreachable" });
        else if (err?.code === "rate_limited") setPhase({ name: "limited" });
        else setPhase({ name: "error", text: messageFor(e) });
      },
    );
    // `f.set` is stable; the look-up depends on the attempt only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, mode, wingetId, canAct]);

  const name = x.name.trim() || entry?.name || wingetId || "";
  const { silent } = linesOf(x, check.inspect.result);
  const own = mode === "installer" || mode === "portable";
  const checked = own && (x.sha256.trim() !== "" || check.inspect.result !== null);
  const showBody = mode === "preinstalled" || (mode === "winget" && phase.name === "ready") || checked;

  // Why Add waits: always a visible sentence, never a silent disabled button.
  let why: string | null = null;
  if (mode === "winget" && phase.name === "loading") why = review.blocked.resolving;
  else if (mode === "winget" && phase.name !== "ready") why = review.blocked.unavailable;
  else if (own && check.phase === "checking") why = review.blocked.checking;
  else if (own && x.sha256.trim() === "") why = check.tooBig ? review.blocked.noFile : review.blocked.noLink;
  else if (silent.state === "unknown") why = review.blocked.unknown;
  else if (silent.state === "needs_answer") why = review.blocked.needsAnswer;

  async function save(values: FormValues) {
    const before = check.checkedUrl !== null && check.sizeBytes !== null && values.installUrl.trim() === check.checkedUrl ? checkedBefore(values.installUrl, values.sha256, check.sizeBytes) : undefined;
    const common = { name: values.name.trim(), description: values.description.trim() || undefined, hue: values.hue };
    const id = await createDesktop({ ...common, desktop: desktopSpec(values, before) });
    toast(appEditStrings.created(common.name));
    navigate(`/apps/${id}?tab=access&added=1`, { replace: true });
  }

  const publisher = x.resolved?.publisher ?? check.inspect.result?.companyName ?? check.inspect.result?.signer;
  const title = mode === "winget" ? review.title(name || wingetId || "") : review.titles[mode];
  const lead = review.leads[mode];
  const dup = duplicate.status === "ready" ? duplicate.data : null;
  const errorCount = Object.values(f.errors).filter(Boolean).length;

  return (
    <div className="dash-page apps-add">
      <PageHeader title={title} lead={showBody || mode !== "winget" ? lead : undefined} back={{ to: "/apps/new", label: t.back }} />
      <form
        ref={form}
        className="apps-add__grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (canAct && why === null) void f.submit(save, form.current);
        }}
      >
        <aside className="apps-add__summary dash-card" aria-label={review.aside}>
          <AppGlyph name={name || "?"} hue={x.hue ?? entry?.hue} size="lg" />
          <div className="apps-add__who">
            <p className="apps-add__name" title={name}>
              {name || review.aside}
            </p>
            {publisher ? <p className="apps-add__by">{review.by(publisher)}</p> : null}
            {x.version.trim() ? <p className="apps-add__by">{review.versionOf(x.version.trim())}</p> : null}
          </div>
        </aside>

        <div className="apps-add__main dash-card dash-card--pad">
          {!canAct ? <InlineNotice tone="neutral" title={review.viewer} /> : null}
          {entry?.warning === "unrestricted_browser" ? <InlineNotice tone="warning" title={review.firefoxWarning} /> : null}
          {dup !== null ? (
            <InlineNotice
              tone="neutral"
              title={review.duplicate(dup.name)}
              action={
                <Link className="dash-link" to={`/apps/${dup._id}`}>
                  {review.openIt}
                </Link>
              }
            />
          ) : null}

          {mode === "winget" && phase.name === "loading" ? (
            <div role="status" aria-label={review.resolving(name)}>
              <p className="dash-muted apps-add__looking">{review.resolving(name)}</p>
              <SkeletonBlock lines={4} />
            </div>
          ) : null}
          {phase.name === "unsupported" ? (
            <InlineNotice
              tone="danger"
              alert
              title={t.unsupported[phase.kind](name)}
              action={
                <Link className="rb-btn rb-btn--ghost dash-btn--sm" to="/apps/new?kind=desktop&source=installer">
                  {review.useInstaller}
                </Link>
              }
            />
          ) : null}
          {phase.name === "unreachable" || phase.name === "limited" || phase.name === "error" ? (
            <InlineNotice
              tone="warning"
              alert
              title={phase.name === "unreachable" ? review.unreachable : phase.name === "limited" ? review.rateLimited : phase.text}
              action={
                <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => setAttempt((a) => a + 1)}>
                  {review.tryAgain}
                </Button>
              }
            />
          ) : null}

          {own ? <InstallerCheck f={f} check={check} readOnly={!canAct} /> : null}

          {showBody ? <DesktopBody f={f} check={check} readOnly={!canAct} isNew appKey="new" disclosures={disclosures} onVersion={() => disclosures.setMore(true)} /> : null}
        </div>

        <div className="apps-add__bar">
          <FormError error={f.serverError} />
          {errorCount > 0 ? <InlineNotice tone="danger" title={strings.validate.fixErrors(errorCount)} /> : null}
          <Button type="submit" disabled={!canAct || f.pending || why !== null} aria-busy={f.pending}>
            {f.pending ? review.adding : name ? review.add(name) : t.add}
          </Button>
          {why !== null && canAct ? <p className="apps-add__why">{why}</p> : null}
          <Link to="/apps/new" className="rb-btn rb-btn--ghost">
            {review.cancel}
          </Link>
        </div>
      </form>
    </div>
  );
}
