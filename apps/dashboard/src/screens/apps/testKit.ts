import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** Tests only: waits until the lazy chunks of the app screens (`AppEdit` and the page's tabs) have rendered. */
// A cold lazy chunk (the first website or Windows screen of a run) can take longer than the default second to transform.
export const settleApp = () => waitFor(() => expect(document.querySelector("[data-suspense]")).toBeNull(), { timeout: 8000 });
