import { useShell } from "../../lib/store";
import { BroadcastFullscreen } from "./BroadcastFullscreen";
import { DeviceLock } from "./DeviceLock";
import { pickFullscreen } from "./logic";
import "./notice.css";

/**
 * The page of a cover window (`shell.html#/cover`, one per monitor while a device lock or a
 * full-screen notice is wanted; Phase 5 Step 12). It reads the shell state and shows the same plain
 * view the desktop window shows: the lock wins over a notice. It has no sign-in and no launching;
 * the hidden administrator exit still works (installed for every shell page). When nothing is wanted
 * any more (the window is about to be destroyed) it shows a plain background, never a flash of UI.
 */
export function CoverRoot() {
  const lock = useShell((s) => s.deviceLock ?? null);
  const broadcasts = useShell((s) => s.broadcasts);
  const orgName = useShell((s) => s.agent?.orgName ?? null);

  if (lock) {
    return <DeviceLock lock={lock} orgName={orgName} />;
  }
  const notice = pickFullscreen(broadcasts);
  if (notice) {
    return <BroadcastFullscreen key={notice.id} broadcast={notice} orgName={orgName} />;
  }
  return <div className="rb-cover" data-testid="cover-empty" />;
}
