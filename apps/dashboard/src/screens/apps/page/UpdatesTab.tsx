import type { FormEvent } from "react";
import type { AppDetail, UpdateMode } from "../../../data/types";
import UpdatesCard from "../../AppUpdates";
import type { FormApi } from "../appForm";

/** "Updates" of a Windows app: version, update mode and the vendor feed (one form with Details, one save bar). */
export default function UpdatesTab({
  d,
  f,
  mode,
  browser,
  readOnly,
  revision,
  onRolledBack,
  onSubmit,
}: {
  d: AppDetail;
  f: FormApi;
  mode: UpdateMode;
  browser: boolean;
  readOnly: boolean;
  revision: number;
  onRolledBack: (revision: number) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="apps-updates" noValidate onSubmit={onSubmit}>
      <fieldset disabled={readOnly} className="apps-fieldset">
        <UpdatesCard d={d} f={f} mode={mode} browser={browser} isNew={false} readOnly={readOnly} revision={revision} onRolledBack={onRolledBack} />
      </fieldset>
    </form>
  );
}
