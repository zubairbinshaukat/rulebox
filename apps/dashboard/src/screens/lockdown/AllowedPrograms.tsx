import { useState } from "react";
import { Button, InfoTip, Pill } from "@rulebox/ui";
import { useRemoveException } from "../../data/lockdown";
import type { ExceptionRow } from "../../data/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { formatDate } from "../../lib/format";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { LkSection } from "./Section";
import { lockdownErrorMessage, lockdownStrings as s } from "./strings";

/**
 * "Extra allowed programs": the programs allowed from the review list (newest first). A rule that matches one exact version is marked
 * "Allow again after updates"; the fingerprint is never in the row (only in its hover text). Admins remove a program after a question.
 */
export function AllowedPrograms({ exceptions, truncated, className }: { exceptions: ExceptionRow[]; truncated: boolean; className?: string }) {
  const remove = useRemoveException();
  const canAct = useCan("admin");
  const toast = useToast();
  const [removing, setRemoving] = useState<ExceptionRow | null>(null);
  return (
    <LkSection title={s.exceptionsTitle} info={s.exceptionsInfo} className={["lk-extra", className ?? ""].filter(Boolean).join(" ")}>
      {exceptions.length === 0 ? <p className="dash-muted lk-extra__none">{s.exceptionsNone}</p> : null}
      {exceptions.length > 0 ? (
        <ul className="lk-extra__list" aria-label={s.exceptionsTitle}>
          {exceptions.map((e) => (
            <li key={e._id} className="lk-extra__item" title={s.exceptionTitle(e.rule) || undefined}>
              <span className="lk-extra__text">
                <span className="lk-extra__what">{s.exceptionWhat(e.rule)}</span>
                <span className="lk-extra__sub">
                  {[s.exceptionKinds[e.rule.kind], e.appName ? s.forApp(e.appName) : null, e.reason || null, formatDate(e.createdAt)].filter(Boolean).join(" · ")}
                </span>
                {e.rule.kind === "hash" ? (
                  <span className="lk-extra__flag">
                    <Pill tone="warning">{s.breaksOnUpdate}</Pill>
                    <InfoTip label={`About ${s.breaksOnUpdate}`}>{s.breaksOnUpdateHelp}</InfoTip>
                  </span>
                ) : null}
              </span>
              {canAct ? (
                <Button variant="ghost" className="dash-btn--sm" aria-label={`${s.removeException}: ${e.rule.fileName ?? s.exceptionWhat(e.rule)}`} onClick={() => setRemoving(e)}>
                  {s.removeException}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {truncated ? <p className="dash-muted">{s.exceptionsTruncated}</p> : null}
      {/* The dialog's own form must not submit the page's form (React events bubble through the portal). */}
      <div style={{ display: "contents" }} onSubmit={(e) => e.stopPropagation()}>
        <ConfirmDialog
          open={removing !== null}
          title={s.removeExceptionTitle(removing?.rule.fileName ?? "this program")}
          body={s.removeExceptionBody}
          confirmLabel={s.removeException}
          danger
          onConfirm={() => remove({ exceptionId: removing?._id ?? "" })}
          onDone={() => toast(s.exceptionRemoved)}
          onClose={() => setRemoving(null)}
          describeError={lockdownErrorMessage}
        />
      </div>
    </LkSection>
  );
}
