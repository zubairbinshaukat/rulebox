import type { InstallState } from "../../data/types";

export const installStateStrings = {
  pending: "Pending",
  downloading: "Downloading",
  installing: "Installing",
  installed: "Installed",
  failed: "Failed",
  removing: "Removing",
  removed: "Removed",
  unsupported: "Unsupported",
} as const satisfies Record<InstallState, string>;
