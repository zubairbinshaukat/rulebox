import type { AppDetail, WebPermissions } from "../../../data/types";
import { AppPermissions } from "../../AppPermissions";

/** "Permissions" of a website: the eight switches (their own save) and what was blocked. Two columns on a laptop. */
export default function PermissionsTab(props: {
  d: AppDetail;
  revision: number;
  readOnly: boolean;
  draft: WebPermissions;
  onDraft: (next: WebPermissions | ((prev: WebPermissions) => WebPermissions)) => void;
  onSaved: (revision: number) => void;
  onReload: () => void;
}) {
  return (
    <div className="apps-perms">
      <AppPermissions {...props} />
    </div>
  );
}
