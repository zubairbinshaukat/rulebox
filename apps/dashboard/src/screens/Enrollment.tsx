import { useCallback, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useRevokeEnrollmentCode } from "../data/enrollment";
import type { EnrollmentCodeRow } from "../data/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageHeader } from "../components/PageHeader";
import { useCan } from "../lib/member";
import { useToast } from "../lib/toast";
import { strings } from "../lib/strings";
import { AddPcWizard } from "./enrollment/AddPcWizard";
import { CodesAside } from "./enrollment/CodesAside";
import { enrollText as s } from "./enrollment/strings";
import "./enrollment/enrollment.css";

/**
 * `/enrollment`, "Add a PC": a three-step wizard (create a code, install on the PC, done) with the list of codes beside it. The code
 * lives only in the wizard's state: leaving the page drops it, and it never goes to the URL, storage, a toast or the console. The
 * wizard keeps the row id of the code it watches in `?watch=`; the list's "See progress" sets the same address. Revoke is a major
 * action (fresh step-up, type the name).
 */
export default function Enrollment() {
  const canAct = useCan("admin");
  const [, setParams] = useSearchParams();
  const [revoking, setRevoking] = useState<EnrollmentCodeRow | null>(null);
  const revoke = useRevokeEnrollmentCode();
  const toast = useToast();
  const asideTitle = useRef<HTMLHeadingElement>(null);

  const watch = useCallback(
    (row: EnrollmentCodeRow) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("watch", row._id);
          next.delete("group");
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  return (
    <div className="dash-page enroll">
      <PageHeader title={s.title} lead={s.lead} />
      <div className="dash-split">
        <div className="dash-split__main">
          <AddPcWizard canAct={canAct} onSeeCodes={() => asideTitle.current?.focus()} />
        </div>
        <div className="dash-split__aside">
          <CodesAside canAct={canAct} onRevoke={setRevoking} onWatch={watch} headingRef={asideTitle} />
        </div>
      </div>
      <ConfirmDialog
        open={revoking !== null}
        title={s.revokeTitle}
        body={s.revokeBody}
        confirmLabel={strings.common.revoke}
        danger
        typeToConfirm={revoking?.label}
        onConfirm={() => revoke({ tokenId: revoking!._id })}
        onDone={() => toast(s.revoked)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
