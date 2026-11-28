import { lazy, Suspense, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router";
import { Button, InfoTip } from "@rulebox/ui";
import IconApps from "~icons/solar/box-linear";
import IconArrow from "~icons/solar/alt-arrow-right-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import IconDanger from "~icons/solar/danger-circle-linear";
import IconDisk from "~icons/solar/sd-card-linear";
import IconInfo from "~icons/solar/info-circle-linear";
import IconMemory from "~icons/solar/cpu-linear";
import IconSettings from "~icons/solar/refresh-linear";
import IconShield from "~icons/solar/shield-check-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import { useSetKiosk } from "../../data";
import type { DevicePage } from "../../data/types";
import { Card } from "../../components/Card";
import { RelativeTime } from "../../components/RelativeTime";
import { messageFor } from "../../lib/errors";
import { formatDate, formatGb } from "../../lib/format";
import { kioskPhaseStrings } from "../../lib/screenStrings/kioskPhase";
import { shellHealthStrings } from "../../lib/screenStrings/shellHealth";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { TechnicalDetails, type TechItem } from "./TechnicalDetails";
import { browsersText, buildNumber, diskFreeGb, editionName, isManaged, memoryMb, memoryText, windowsLine } from "./format";
import type { Problem, ProblemAction, ProblemRun, ProblemTab } from "./problems";
import { splitProblems } from "./problems";
import { deviceText as t } from "./strings";
import { overviewTiles, type Tile } from "./tiles";

// The unlock confirmation and the USB button load when they are used.
const UnlockDialog = lazy(() => import("./LockDialog").then((m) => ({ default: m.UnlockDialog })));
const EndUsbButton = lazy(() => import("./EndUsbButton"));

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
const TILE_ICONS: Record<Tile["id"], Icon> = { settings: IconSettings, protection: IconShield, apps: IconApps, disk: IconDisk, memory: IconMemory };
const SEVERITY_ICONS: Record<Problem["severity"], Icon> = { danger: IconDanger, warning: IconWarn, info: IconInfo };

export interface OverviewProps {
  d: DevicePage;
  problems: Problem[];
  now: number;
  /** Open another tab of the page (`focus` names the control to focus there). */
  onTab: (tab: ProblemTab, focus?: "group" | "remove") => void;
}

/**
 * The Overview (plan 3 and 4): four numbers, what needs attention with ONE thing to do about each, and what this PC is.
 * Laptop and up: the problems on the left (2/3), the PC's card on the right; a phone stacks them with the card last.
 */
export default function OverviewTab({ d, problems, now, onTab }: OverviewProps) {
  const { attention, goodToKnow } = splitProblems(problems);
  const [unlocking, setUnlocking] = useState(false);
  const run = useRunner(d, () => setUnlocking(true));
  // A PC that never reported: its one note ("waiting for it to connect") is the whole story, so it is not folded away.
  const openInfo = d.report === null;
  const primaryId = [...attention, ...(openInfo ? goodToKnow : [])].find((p) => p.action !== undefined)?.id;
  const shown = (list: Problem[], offset = 0) =>
    list.map((p, i) => <ProblemCard key={p.id} problem={p} primary={p.id === primaryId} index={offset + i} deviceId={d._id} onTab={onTab} run={run} />);

  return (
    <div className="ov">
      {d.revoked ? null : <Tiles d={d} now={now} onTab={onTab} />}
      <div className="dash-split ov__split">
        <div className="dash-split__main">
          <section className="ov__section" aria-labelledby="ov-attention">
            <h2 id="ov-attention" className="dash-section-title">
              {t.attention}
              {attention.length > 0 ? (
                <span className="ov-count" data-tone={attention.some((p) => p.severity === "danger") ? "danger" : "warning"}>
                  {attention.length}
                </span>
              ) : null}
            </h2>
            {attention.length > 0 ? (
              <ul className="ov-problems">{shown(attention)}</ul>
            ) : openInfo && goodToKnow.length > 0 ? null : (
              <AllClear d={d} />
            )}
            {openInfo && goodToKnow.length > 0 ? <ul className="ov-problems">{shown(goodToKnow, attention.length)}</ul> : null}
          </section>
          {!openInfo && goodToKnow.length > 0 ? (
            <details className="dash-advanced ov-more">
              <summary>{t.goodToKnow(goodToKnow.length)}</summary>
              <div className="dash-advanced__body">
                <ul className="ov-problems">{shown(goodToKnow, attention.length)}</ul>
              </div>
            </details>
          ) : null}
        </div>
        <aside className="dash-split__aside">
          <About d={d} />
        </aside>
      </div>
      {unlocking ? (
        <Suspense fallback={null}>
          <UnlockDialog deviceId={d._id} open onClose={() => setUnlocking(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** What a "run" action does, through the usual data hooks; `busy` is the action in flight. */
function useRunner(d: DevicePage, unlock: () => void) {
  const setKiosk = useSetKiosk();
  const toast = useToast();
  const [busy, setBusy] = useState<ProblemRun | null>(null);
  const run = (what: "kioskOn" | "unlock") => {
    if (what === "unlock") return unlock();
    if (busy !== null) return;
    setBusy(what);
    setKiosk({ deviceId: d._id, expectedRevision: d.revision, enabled: true })
      .then(() => toast(strings.common.saved))
      .then(
      () => setBusy(null),
      (e) => {
        setBusy(null);
        toast(messageFor(e), "danger");
      },
    );
  };
  return Object.assign(run, { busy });
}
type Runner = ReturnType<typeof useRunner>;

// ---------------------------------------------------------------- tiles

function Tiles({ d, now, onTab }: { d: DevicePage; now: number; onTab: OverviewProps["onTab"] }) {
  const tiles = overviewTiles(d, now);
  return (
    <ul className="ov-tiles" aria-label={t.tilesLabel}>
      {tiles.map((tile, i) => (
        <li key={tile.id} className="ov-tiles__item" data-wide={tile.wide || undefined}>
          <TileView tile={tile} index={i} onTab={onTab} />
        </li>
      ))}
    </ul>
  );
}

function TileView({ tile, index, onTab }: { tile: Tile; index: number; onTab: OverviewProps["onTab"] }) {
  const Glyph = TILE_ICONS[tile.id];
  const body = (
    <>
      <span className="ov-tile__top">
        <span className="ov-tile__icon" aria-hidden="true">
          <Glyph />
        </span>
        <span className="ov-tile__label">{tile.label}</span>
      </span>
      <span className="ov-tile__value">{tile.value}</span>
      {tile.sub ? <span className="ov-tile__sub">{tile.sub}</span> : null}
    </>
  );
  const style = { animationDelay: `${index * 25}ms` };
  if (tile.tab) {
    const tab = tile.tab;
    return (
      <button type="button" className="ov-tile ov-tile--link dash-enter" data-tone={tile.tone} style={style} onClick={() => onTab(tab)} aria-label={`${tile.label}: ${tile.value}. ${t.tile.open(tile.label)}`}>
        {body}
        <span className="ov-tile__go" aria-hidden="true">
          <IconArrow />
        </span>
      </button>
    );
  }
  return (
    <div className="ov-tile dash-enter" data-tone={tile.tone} style={style}>
      {body}
      {tile.info ? (
        <span className="ov-tile__tip">
          <InfoTip label={`About ${tile.label}`}>{tile.info}</InfoTip>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- problems

function AllClear({ d }: { d: DevicePage }) {
  const at = d.report?.updatedAt;
  return (
    <div className="ov-clear dash-enter" role="status">
      <span className="ov-clear__icon" aria-hidden="true">
        <IconCheck />
      </span>
      <div>
        <p className="ov-clear__title">{d.revoked ? t.disconnectedNote : t.allClear}</p>
        <p className="ov-clear__sub">{at === undefined ? t.allClearNoReport : <>{t.lastReport} <RelativeTime ms={at} /></>}</p>
      </div>
    </div>
  );
}

function ProblemCard({ problem: p, primary, index, deviceId, onTab, run }: { problem: Problem; primary: boolean; index: number; deviceId: string; onTab: OverviewProps["onTab"]; run: Runner }) {
  const Glyph = SEVERITY_ICONS[p.severity];
  return (
    <li className="ov-problem-wrap">
      <article className="ov-problem dash-enter" data-severity={p.severity} style={{ animationDelay: `${Math.min(index, 5) * 35}ms` }}>
        <span className="ov-problem__icon" aria-hidden="true">
          <Glyph />
        </span>
        <div className="ov-problem__text">
          <h3 className="ov-problem__title">{p.title}</h3>
          <p className="ov-problem__body">{p.body}</p>
          {p.tech ? <TechnicalDetails items={p.tech.map((x): TechItem => ({ label: x.label, value: x.value }))} /> : null}
        </div>
        {p.action ? (
          <div className="ov-problem__action">
            <ActionButton action={p.action} primary={primary} deviceId={deviceId} onTab={onTab} run={run} />
          </div>
        ) : null}
      </article>
    </li>
  );
}

function ActionButton({ action, primary, deviceId, onTab, run }: { action: ProblemAction; primary: boolean; deviceId: string; onTab: OverviewProps["onTab"]; run: Runner }) {
  const variant = primary ? "primary" : "ghost";
  switch (action.kind) {
    case "tab":
      return (
        <Button variant={variant} onClick={() => onTab(action.tab, action.focus)}>
          {action.label}
        </Button>
      );
    case "link":
      return (
        <Link className={`rb-btn rb-btn--${variant}`} to={action.to}>
          {action.label}
        </Link>
      );
    case "run": {
      if (action.run === "endUsb") {
        return (
          <Suspense fallback={<Button variant={variant} disabled>{action.label}</Button>}>
            <EndUsbButton deviceId={deviceId} label={action.label} variant={variant} disabled={run.busy !== null} />
          </Suspense>
        );
      }
      const what = action.run;
      const busy = run.busy === what;
      return (
        <Button variant={variant} onClick={() => run(what)} disabled={run.busy !== null} aria-busy={busy}>
          {busy ? t.running : action.label}
        </Button>
      );
    }
  }
}

// ---------------------------------------------------------------- about

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ov-about__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function About({ d }: { d: DevicePage }) {
  const r = d.report;
  const windows = windowsLine(r);
  const ram = memoryText(memoryMb(r));
  const free = diskFreeGb(r);
  const browsers = browsersText(r?.compat);
  return (
    <Card title={t.about} className="ov-about-card">
      <dl className="ov-about">
        {windows ? <Row label={t.windows}>{windows}</Row> : null}
        {ram ? (
          <Row label={t.memory}>
            {ram}
            {r?.compat?.liteMode ? (
              <span className="ov-about__note">
                · {t.lite}
                <InfoTip label={`About ${t.lite}`}>{t.liteInfo}</InfoTip>
              </span>
            ) : null}
          </Row>
        ) : null}
        {free !== undefined ? <Row label={t.diskFree}>{formatGb(free)}</Row> : null}
        {browsers ? <Row label={t.browsers}>{browsers}</Row> : null}
        {isManaged(r?.compat) ? <Row label={t.companyDomain}>{t.yes}</Row> : null}
        <Row label={t.enrolled}>{formatDate(d.enrolledAt)}</Row>
        {r ? (
          <Row label={t.lastReport}>
            <RelativeTime ms={r.updatedAt} />
          </Row>
        ) : null}
      </dl>
      {r === null ? <p className="dash-muted ov-about__none">{t.noReport}</p> : null}
      <TechnicalDetails items={aboutTech(d)} label={t.tech} />
    </Card>
  );
}

/** For support: ids, the build, the edition as Windows spells it, the keys and the raw states. */
function aboutTech(d: DevicePage): TechItem[] {
  const r = d.report;
  const items: TechItem[] = [{ label: t.techId, value: d._id }];
  if (r === null) return items;
  const build = buildNumber(r);
  if (build) items.push({ label: t.techBuild, value: build });
  const edition = r.osEdition ?? r.compat?.os.editionId;
  if (edition) items.push({ label: t.techEdition, value: editionName(edition) === edition ? edition : `${edition} (${editionName(edition)})` });
  if (r.compat) {
    items.push({ label: t.techArch, value: r.compat.os.arch });
    if (r.compat.os.sMode) items.push({ label: t.techSMode, value: strings.common.yes });
    if (r.compat.webview2 !== undefined) {
      items.push({ label: t.techWebview, value: r.compat.webview2.present && r.compat.webview2.version ? r.compat.webview2.version : t.techWebviewMissing });
    }
  }
  if (r.agentVersion) items.push({ label: t.techAgent, value: r.agentVersion });
  if (r.trustedKeyIds !== undefined) {
    items.push({ label: t.techKeys, value: r.trustedKeyIds.length === 0 ? t.techKeysNone : r.trustedKeyIds.join(", ") });
  }
  if (r.kioskPhase) items.push({ label: t.techKioskPhase, value: kioskPhaseStrings[r.kioskPhase] });
  if (r.shellHealth) items.push({ label: t.techStaffApp, value: shellHealthStrings[r.shellHealth] });
  return items;
}
