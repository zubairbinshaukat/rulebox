import { Button } from "@rulebox/ui";
import { errorCodeOf, messageFor } from "../lib/errors";
import { strings } from "../lib/strings";
import { InlineNotice } from "./Notice";

/**
 * A mutation error next to its form. `stale_edit` gets the special
 * "Someone else changed this" notice with Reload (Section 4.13).
 */
export function FormError({ error, onReload }: { error: unknown; onReload?: () => void }) {
  if (!error) return null;
  if (errorCodeOf(error) === "stale_edit") {
    return (
      <InlineNotice
        tone="warning"
        alert
        title={strings.common.staleTitle}
        detail={strings.common.staleDetail}
        action={
          onReload ? (
            <Button variant="ghost" className="dash-btn--sm" onClick={onReload}>
              {strings.common.reload}
            </Button>
          ) : undefined
        }
      />
    );
  }
  return <InlineNotice tone="danger" alert title={messageFor(error)} />;
}
