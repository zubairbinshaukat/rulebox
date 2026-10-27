import { Button } from "@rulebox/ui";
import { errorCodeOf, messageFor, toAppError } from "../lib/errors";
import { strings } from "../lib/strings";
import { InlineNotice } from "./Notice";
import { serverFieldError } from "./serverField";

/**
 * A mutation error next to its form. `stale_edit` gets the special
 * "Someone else changed this" notice with Reload (Section 4.13).
 * `fields`: errors about these fields are shown under the field instead
 * (`serverFieldError`). `describe`: a screen's own sentence for an error
 * (null = the usual one).
 */
export function FormError({
  error,
  onReload,
  fields,
  describe,
}: {
  error: unknown;
  onReload?: () => void;
  fields?: readonly string[];
  describe?: (error: unknown) => string | null;
}) {
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
  const field = toAppError(error)?.field;
  if (fields && field !== undefined && fields.includes(field) && serverFieldError(error, field) !== null) return null;
  return <InlineNotice tone="danger" alert title={describe?.(error) ?? messageFor(error)} />;
}
