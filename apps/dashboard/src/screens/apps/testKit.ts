import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** Tests only: waits until the lazy chunks of the app screens (`AppEdit` and the page's tabs) have rendered. */
export const settleApp = () => waitFor(() => expect(document.querySelector("[data-suspense]")).toBeNull());
