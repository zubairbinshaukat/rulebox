import type { OpenAction } from "@rulebox/types";

import { call } from "./tauri";

/**
 * Open a file the way a double-click does: the backend decides (viewer, a
 * handler app, blocked, nothing), and a viewer opens in its own window.
 * Callers that have no dialog of their own can ignore the result; the shell
 * windows get a notice from the backend for `blocked` and `noHandler`.
 */
export async function openFile(path: string): Promise<OpenAction> {
  const action = await call("fs_open", { path });
  if (action.action === "viewer") {
    // `open_doc` takes "view" for every viewer; the window works out the kind from the name.
    await call("open_doc", { kind: "view", path: action.path });
  }
  return action;
}
