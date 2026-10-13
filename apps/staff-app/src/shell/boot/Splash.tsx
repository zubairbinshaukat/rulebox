import { LogoMotion } from "@rulebox/ui";

import type { LogoSequence } from "./useLogoSequence";

/** Full-window splash. Cut short via `seq.skip()` when the next screen is ready. */
export function Splash({ seq }: { seq: LogoSequence }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--rb-bg)",
        zIndex: 50,
      }}
    >
      <LogoMotion
        key={seq.key}
        animation={seq.animation}
        onCovered={seq.onCovered}
        onDone={seq.onDone}
      />
    </div>
  );
}
