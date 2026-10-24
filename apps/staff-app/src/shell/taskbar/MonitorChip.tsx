import { formatMemory, formatPercent, useMonitorSample } from "../../lib/monitor";

/**
 * Debug builds: the machine's memory and CPU, live, in the taskbar. A click
 * opens the per-app breakdown. Release builds send no samples, so it never shows.
 */
export function MonitorChip({ onOpen }: { onOpen: (element: Element) => void }) {
  const sample = useMonitorSample();
  if (!sample) {
    return null;
  }
  return (
    <button
      type="button"
      className="rb-chip rb-chip--dev"
      aria-label={`Resources: memory ${formatMemory(sample.memUsed)} of ${formatMemory(sample.memTotal)}, CPU ${formatPercent(sample.cpuPercent)}`}
      title="Resources (dev build)"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="rb-chip__devtag" aria-hidden>
        DEV
      </span>
      <span className="rb-chip__stack">
        <span>
          {formatMemory(sample.memUsed)} / {formatMemory(sample.memTotal)}
        </span>
        <span className="rb-chip__muted">
          CPU {formatPercent(sample.cpuPercent)} · RB {formatMemory(sample.ruleboxBytes)}
        </span>
      </span>
    </button>
  );
}
