import { useEffect, useState } from "react";

import { msUntilNextMinute } from "./status";

/** Time and a short date from the OS locale. One timer, armed to the minute. */
export function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const next = new Date();
      setNow(next);
      timer = window.setTimeout(arm, Math.max(250, msUntilNextMinute(next)));
    };
    timer = window.setTimeout(arm, Math.max(250, msUntilNextMinute(new Date())));
    return () => window.clearTimeout(timer);
  }, []);

  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const date = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(now);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        justifyContent: "center",
        padding: "0 10px",
        lineHeight: 1.15,
        minWidth: 72,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{time}</span>
      <span style={{ fontSize: 12, color: "var(--rb-muted)" }}>{date}</span>
    </div>
  );
}
