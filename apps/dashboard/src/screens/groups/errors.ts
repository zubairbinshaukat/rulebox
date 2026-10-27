import { serverFieldError } from "../../components/serverField";
import type { PlanScreen } from "../../data/types";
import { toAppError } from "../../lib/errors";
import { planLimitMessage } from "../settings/strings";
import { groupText } from "./strings";

/** The server's refusal of a group field (`invalid_argument` / `conflict`), shown under that field. */
export function groupFieldError(error: unknown, field: "name" | "description"): string | null {
  return serverFieldError(error, field, (e) =>
    e.code === "conflict" ? groupText.nameTaken : field === "name" ? groupText.nameInvalid : groupText.descriptionInvalid,
  );
}

/** Screen sentences for `plan_limit` and `has_dependents`; null = the usual sentence. */
export function groupErrorMessage(error: unknown, plan?: PlanScreen | null): string | null {
  const e = toAppError(error);
  if (e?.code === "plan_limit") return planLimitMessage(e.detail, plan?.plan, plan?.limits.maxGroups);
  if (e?.code === "has_dependents") return groupText.hasDependents(e.detail);
  return null;
}
