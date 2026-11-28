import type { ReactNode } from "react";
import { Button, InfoTip } from "@rulebox/ui";
import { strings } from "../../lib/strings";
import { lockdownStrings as s } from "./strings";

/**
 * The bar at the bottom of the lockdown page while there are unsaved changes: how many, what they are (in the (i)), Undo and the one
 * main action, Save. It sticks to the bottom of the window; the form's error sits right above it. It is the form's submit button.
 */
export function SaveBar({
  count,
  labels,
  more,
  pending,
  onUndo,
  error,
}: {
  count: number;
  labels: readonly string[];
  more: number;
  pending: boolean;
  onUndo: () => void;
  /** The form's error (above the bar). */
  error: ReactNode;
}) {
  return (
    <div className="lk-barwrap">
      {error}
      <div className="lk-bar dash-enter" role="region" aria-label={s.saveBarLabel}>
        <div className="lk-bar__msg">
          <span className="lk-bar__dot" aria-hidden="true" />
          <span className="lk-bar__count">{s.unsaved(count)}</span>
          <InfoTip label={s.changesInfoLabel} placement="top">
            <ul className="lk-tiplist">
              {labels.map((l) => (
                <li key={l}>{l}</li>
              ))}
              {more > 0 ? <li>{s.changesInfoMore(more)}</li> : null}
            </ul>
          </InfoTip>
        </div>
        <div className="lk-bar__actions">
          <Button variant="ghost" onClick={onUndo} disabled={pending}>
            {s.discard}
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? strings.common.saving : s.save}
          </Button>
        </div>
      </div>
    </div>
  );
}
