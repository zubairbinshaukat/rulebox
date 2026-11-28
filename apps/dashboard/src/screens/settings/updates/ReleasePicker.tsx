import { Button, InfoTip, Pill } from "@rulebox/ui";
import IconRefresh from "~icons/solar/refresh-linear";
import IconOut from "~icons/solar/arrow-right-up-linear";
import IconBox from "~icons/solar/box-minimalistic-linear";
import type { GithubRelease, GithubReleasesHandle } from "../../../data/release/api";
import { Card } from "../../../components/Card";
import { EmptyState } from "../../../components/EmptyState";
import { InlineNotice } from "../../../components/Notice";
import { RelativeTime } from "../../../components/RelativeTime";
import { SkeletonBlock } from "../../../components/Skeleton";
import { formatDate, formatTime } from "../../../lib/format";
import { strings } from "../../../lib/strings";
import type { ReleaseValue } from "../releaseRules";
import { updates as s } from "../strings";
import { NotesView } from "./NotesView";
import { pickerView } from "./model";
import { newestStable, relationToCurrent, valueOfGithub } from "./pickRules";

/**
 * The releases of the Rulebox repository, newest first, as one radio group. A release that cannot be used is shown with the reason and
 * cannot be picked. Notes are plain text (`ReleaseNotes`). Problems stay visible inline; the (i) texts only explain.
 */
export function ReleasePicker({
  gh,
  current,
  selectedTag,
  disabled,
  onPick,
}: {
  gh: GithubReleasesHandle;
  current: ReleaseValue | null;
  selectedTag: string | null;
  disabled: boolean;
  onPick: (release: GithubRelease) => void;
}) {
  const { state } = gh;
  const view = pickerView(state);
  const ok = state.status === "ready" && state.data.status === "ok" ? state.data : null;
  const newest = ok ? newestStable(ok.releases) : null;
  const refresh = (
    <Button variant="ghost" className="dash-btn--sm" onClick={gh.refresh} disabled={!gh.canRefresh || gh.refreshing} aria-busy={gh.refreshing}>
      <IconRefresh aria-hidden="true" />
      {gh.refreshing ? s.refreshing : s.refresh}
    </Button>
  );
  return (
    <Card
      level={3}
      title={s.releasesTitle}
      className="upd__list"
      actions={
        <div className="upd-tools">
          {ok ? (
            <span className="upd-tools__checked">
              {s.checked} <RelativeTime ms={ok.checkedAt} />
            </span>
          ) : null}
          {refresh}
        </div>
      }
    >
      {view === "loading" ? (
        <div aria-busy="true" aria-label={strings.app.loading}>
          <SkeletonBlock lines={6} />
        </div>
      ) : null}

      {view === "unavailable" ? <Unavailable state={state} onRetry={gh.refresh} canRetry={gh.canRefresh && !gh.refreshing} /> : null}

      {view === "empty" ? <EmptyState compact icon={<IconBox />} title={s.emptyTitle} body={s.emptyBody} /> : null}

      {ok && ok.releases.length > 0 ? (
        <div className="upd-list">
          {ok.stale ? (
            <p className="upd-list__stale">
              {s.stale} <RelativeTime ms={ok.checkedAt} />.
            </p>
          ) : null}
          {ok.releases.every((r) => r.problem !== null) ? <InlineNotice tone="warning" title={s.allUnusable} /> : null}
          <div role="radiogroup" aria-label={s.listLabel} className="upd-rows">
            {ok.releases.map((r) => (
              <Row
                key={r.tag}
                release={r}
                current={current}
                isNewest={newest !== null && newest.tag === r.tag}
                checked={selectedTag === r.tag}
                disabled={disabled}
                onPick={() => onPick(r)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Unavailable({ state, onRetry, canRetry }: { state: GithubReleasesHandle["state"]; onRetry: () => void; canRetry: boolean }) {
  const data = state.status === "ready" && state.data.status === "unavailable" ? state.data : null;
  const busy = data?.reason === "rate_limited";
  const title = busy
    ? data.retryAt !== undefined
      ? s.busy(formatTime(data.retryAt))
      : s.busyLater
    : s.loadError;
  return (
    <InlineNotice
      tone="warning"
      title={
        <>
          {title}
          {busy ? (
            <>
              {" "}
              <InfoTip label={s.busyInfoLabel}>{s.busyInfo}</InfoTip>
            </>
          ) : null}
        </>
      }
      action={
        <Button variant="ghost" className="dash-btn--sm" onClick={onRetry} disabled={!canRetry}>
          {strings.common.tryAgain}
        </Button>
      }
    />
  );
}

/** A small label with an (i) that says what it means. */
function Badge({ label, info, tone }: { label: string; info: string; tone?: "warning" }) {
  return (
    <span className="upd-badge">
      <Pill tone={tone}>{label}</Pill>
      <InfoTip label={`About ${label}`}>{info}</InfoTip>
    </span>
  );
}

function Row({
  release: r,
  current,
  isNewest,
  checked,
  disabled,
  onPick,
}: {
  release: GithubRelease;
  current: ReleaseValue | null;
  isNewest: boolean;
  checked: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const value = valueOfGithub(r);
  const usable = value !== null;
  const relation = value ? relationToCurrent(value, current) : null;
  return (
    <div className="upd-row" data-checked={checked || undefined} data-unusable={!usable || undefined}>
      <div className="upd-row__top">
        <label className="upd-row__main">
          <input
            type="radio"
            name="rulebox-release"
            className="upd-row__input"
            checked={checked}
            disabled={!usable || disabled}
            onChange={onPick}
          />
          <span className="upd-row__dot" aria-hidden="true" />
          <span className="upd-row__title">{r.title}</span>
        </label>
        <span className="upd-row__badges">
          {isNewest ? <Pill tone="accent">{s.newest}</Pill> : null}
          {relation === "current" ? (
            <Pill tone="success" dot>
              {s.current}
            </Pill>
          ) : null}
          {r.prerelease ? <Badge tone="warning" label={s.testBuild} info={s.testBuildInfo} /> : null}
          {usable && !r.signed ? <Badge label={s.unsigned} info={s.unsignedInfo} /> : null}
        </span>
        <span className="upd-row__date">{formatDate(r.publishedAt)}</span>
      </div>      {r.problem !== null ? <p className="upd-row__problem">{s.unusable[r.problem]}</p> : null}
      {relation === "changed" ? <p className="upd-row__problem upd-row__problem--warn">{s.warnings.changed}</p> : null}
      <NotesView notes={r.notes} truncated={r.notesTruncated} />
      <a className="dash-link upd-row__link" href={r.pageUrl} target="_blank" rel="noopener noreferrer">
        {s.viewOnGithub}
        <IconOut aria-hidden="true" />
      </a>
    </div>
  );
}
