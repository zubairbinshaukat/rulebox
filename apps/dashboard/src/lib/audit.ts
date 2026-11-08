import { auditStrings } from "./screenStrings/audit";

/** The readable label for an audit action string (falls back to the raw action). */
export function actionLabel(action: string): string {
  return auditStrings.actions[action] ?? action;
}