import { strings } from "./strings";

/** The readable label for an audit action string (falls back to the raw action). */
export function actionLabel(action: string): string {
  return strings.audit.actions[action] ?? action;
}