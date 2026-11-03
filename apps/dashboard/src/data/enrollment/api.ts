import type { ListQuery, ServerList } from "../serverList";
import type { EnrollmentCodeRow, EnrollmentInput, Id } from "../types";

/**
 * Enrollment-code hooks (plan Step 6, Phase 4b). A seam of their own, like `../stepup`:
 * only the Enrollment screen imports `data/enrollment`.
 */
export interface EnrollmentApi {
  /**
   * `enrollmentCodes:list({ nowMs })`, one page. Sort keys `created` (default, newest first) and `expires`;
   * no search and no total (`activeEnrollmentCodes` counts usable codes only). `nowMinute` = `minuteOf(now)`.
   */
  useEnrollmentScreen: (nowMinute: number, query: ListQuery) => ServerList<EnrollmentCodeRow>;
  /** `enrollmentCodes:create` (action): the code is returned ONCE. */
  useCreateEnrollmentCode: () => (args: EnrollmentInput) => Promise<{ code: string; expiresAt: number }>;
  /** `enrollmentCodes:revoke` (major: fresh step-up). */
  useRevokeEnrollmentCode: () => (args: { tokenId: Id }) => Promise<void>;
}
