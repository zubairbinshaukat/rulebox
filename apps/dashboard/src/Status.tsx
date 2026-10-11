import { useQuery } from "convex/react";
import { Panel } from "@rulebox/ui";
import { api } from "@convex/_generated/api";

export function Status() {
  const ping = useQuery(api.health.ping);
  const text = ping === undefined ? "Backend: connecting…" : `Backend: connected · ${new Date(ping.at).toLocaleTimeString()}`;
  return (
    <Panel size="md" style={{ maxWidth: 420, padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 500 }}>{text}</div>
    </Panel>
  );
}