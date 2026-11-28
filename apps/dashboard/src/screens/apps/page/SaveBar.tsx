import type { ReactNode } from "react";
import { Button } from "@rulebox/ui";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { strings } from "../../../lib/strings";

const t = appAddStrings.saveBar;

/**
 * "Unsaved changes - Discard - Save changes": sticks to the bottom of the window while the page has edits (Details and Updates share
 * one form, so one bar saves both). Problems and a refused save show above the buttons, never only in a tooltip.
 */
export function SaveBar({ pending, onSave, onDiscard, children }: { pending: boolean; onSave: () => void; onDiscard: () => void; children?: ReactNode }) {
  return (
    <div className="apps-savebar" role="region" aria-label={t.unsaved}>
      {children ? <div className="apps-savebar__notes">{children}</div> : null}
      <div className="apps-savebar__row">
        <span className="apps-savebar__text">{t.unsaved}</span>
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={pending}>
          {t.discard}
        </Button>
        <Button type="button" onClick={onSave} disabled={pending} aria-busy={pending}>
          {pending ? strings.common.saving : t.save}
        </Button>
      </div>
    </div>
  );
}
