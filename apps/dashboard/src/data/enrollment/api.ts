import type { EnrollmentCodeRow, EnrollmentInput, Id, PagedState } from "../types";

/**
 * Enrollment-code hooks (plan Step 6). A seam of their own, like `../stepup`:
 * the live list needs Convex's `usePaginatedQuery`, which must not reach the
 * first load (sign-in). Only the Enrollment screen imports `data/enrollment`.
 */
export interface EnrollmentApi {
  /** `enrollmentCodes:list({ nowMs })`, paginated (50), newest first. `nowMinute` = `minuteOf(now)`. */
  useEnrollmentScreen: (nowMinute: number) => PagedState<EnrollmentCodeRow>;
  /** `enrollmentCodes:create` (action): the code is returned ONCE. */
  useCreateEnrollmentCode: () => (args: EnrollmentInput) => Promise<{ code: string; expiresAt: number }>;
  /** `enrollmentCodes:revoke` (major: fresh step-up). */
  useRevokeEnrollmentCode: () => (args: { tokenId: Id }) => Promise<void>;
}
