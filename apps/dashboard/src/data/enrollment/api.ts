import type { ListQuery, ServerList } from "../serverList";
import type { EnrollmentCodeRow, EnrollmentCreated, EnrollmentInput, EnrollmentProgress, Id, QueryState } from "../types";

/**
 * Enrollment-code hooks (plan Step 6, Phase 4b; UI pass: the "Add a PC" wizard). A seam of their own, like `../stepup`:
 * only the Enrollment screen imports `data/enrollment`.
 */
export interface EnrollmentApi {
  /**
   * `enrollmentCodes:list({ nowMs })`, one page. Sort keys `created` (default, newest first) and `expires`;
   * no search and no total (`activeEnrollmentCodes` counts usable codes only). `nowMinute` = `minuteOf(now)`.
   */
  useEnrollmentScreen: (nowMinute: number, query: ListQuery) => ServerList<EnrollmentCodeRow>;
  /**
   * `enrollmentCodes:create` (action): the code is returned ONCE, with the row id (`tokenId`, not secret) that
   * `useEnrollmentProgress` watches and `?watch=` carries.
   */
  useCreateEnrollmentCode: () => (args: EnrollmentInput) => Promise<EnrollmentCreated>;
  /** `enrollmentCodes:revoke` (major: fresh step-up). */
  useRevokeEnrollmentCode: () => (args: { tokenId: Id }) => Promise<void>;
  /**
   * `enrollmentCodes:progress` (viewer): the code being waited on, the PCs that joined with it (newest 10, with presence and kiosk
   * phase), and the download for the install step. Call it ONLY from the component that is on screen while step 2 or 3 of the
   * wizard shows, and pass `null` everywhere else (idle card, step 1, other pages): `null` subscribes to nothing and the state stays
   * `loading`, so nothing runs and nothing is read. A `tokenId` that is not this organization's code (or was deleted) answers
   * `error` with the code `not_found`. The server takes no clock: derive expired / used up with `progressState(progress, now)` and
   * `useNow`.
   */
  useEnrollmentProgress: (tokenId: Id | null) => QueryState<EnrollmentProgress>;
}
