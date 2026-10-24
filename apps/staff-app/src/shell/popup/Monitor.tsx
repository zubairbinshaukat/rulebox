import type { CSSProperties } from "react";
import type { GroupKind } from "@rulebox/types";

import { formatMemory, formatPercent, useMonitorSample } from "../../lib/monitor";

/** Each group's dot colour (an oklch hue; "Other" has none). */
const KIND_HUE: Record<GroupKind, number | null> = {
  shell: 175,
  webApp: 250,
  app: 55,
  agent: 300,
  launcher: 300,
  other: null,
};

const KIND_LABEL: Record<GroupKind, string> = {
  shell: "Rulebox",
  webApp: "Web app",
  app: "App",
  agent: "Rulebox",
  launcher: "Rulebox",
  other: "Other program",
};

/**
 * The developer resource monitor (debug builds): the machine's CPU and
 * memory, what Rulebox uses, and every app and program, live.
 */
export function Monitor() {
  const sample = useMonitorSample();

  if (!sample) {
    return (
      <div className="rb-monitor rb-monitor--waiting">
        <span className="rb-monitor__eyebrow">Resources · dev</span>
        <span>Measuring…</span>
      </div>
    );
  }

  const memShare = sample.memTotal > 0 ? sample.memUsed / sample.memTotal : 0;
  const largest = Math.max(1, ...sample.groups.map((group) => group.bytes));
  return (
    <div className="rb-monitor">
      <div className="rb-monitor__head">
        <span className="rb-monitor__eyebrow">Resources · dev build</span>
        <span className="rb-monitor__hint">every 2 s</span>
      </div>

      <div className="rb-monitor__meters">
        <Meter label="CPU" value={formatPercent(sample.cpuPercent)} share={sample.cpuPercent / 100} />
        <Meter
          label="Memory"
          value={`${formatMemory(sample.memUsed)} of ${formatMemory(sample.memTotal)}`}
          share={memShare}
        />
      </div>

      <div className="rb-monitor__total">
        Rulebox uses <strong>{formatMemory(sample.ruleboxBytes)}</strong> and{" "}
        <strong>{formatPercent(sample.ruleboxCpu)}</strong> CPU
      </div>

      <ul className="rb-monitor__list" aria-label="Memory and CPU by app">
        {sample.groups.map((group) => {
          const hue = KIND_HUE[group.kind];
          const dot: CSSProperties =
            hue === null ? { background: "var(--rb-faint)" } : { background: `oklch(0.62 0.14 ${hue})` };
          return (
            <li key={`${group.kind}:${group.name}`} className="rb-monitor__row">
              <span className="rb-monitor__dot" style={dot} aria-hidden />
              <span className="rb-monitor__name">
                <span className="rb-monitor__title">{group.name}</span>
                <span className="rb-monitor__sub">
                  {KIND_LABEL[group.kind]} · {group.processes} {group.processes === 1 ? "process" : "processes"}
                  {/* Another user's or a service's processes: Windows gives a standard user no figures. */}
                  {group.unreadable > 0 && group.unreadable < group.processes
                    ? ` · ${group.unreadable} not readable`
                    : null}
                </span>
              </span>
              <span className="rb-monitor__figures">
                {group.unreadable === group.processes ? (
                  <span className="rb-monitor__mem rb-monitor__mem--na" title="Runs as another user (e.g. SYSTEM)">
                    not readable
                  </span>
                ) : (
                  <>
                    <span className="rb-monitor__mem">{formatMemory(group.bytes)}</span>
                    <span className="rb-monitor__cpu">{formatPercent(group.cpuPercent)}</span>
                  </>
                )}
              </span>
              <span className="rb-monitor__bar" aria-hidden>
                <span
                  className="rb-monitor__fill"
                  style={{ transform: `scaleX(${group.bytes / largest})`, ...dot }}
                />
              </span>
            </li>
          );
        })}
      </ul>

      <div className="rb-monitor__foot">Memory is the private working set: Task Manager's Memory column.</div>
    </div>
  );
}

function Meter({ label, value, share }: { label: string; value: string; share: number }) {
  const clamped = Math.min(1, Math.max(0, share));
  const tone = clamped > 0.85 ? "var(--rb-danger)" : clamped > 0.65 ? "var(--rb-warning)" : "var(--rb-accent)";
  return (
    <div className="rb-monitor__meter">
      <span className="rb-monitor__meter-label">{label}</span>
      <span className="rb-monitor__meter-value">{value}</span>
      <span className="rb-monitor__bar rb-monitor__bar--meter" aria-hidden>
        <span className="rb-monitor__fill" style={{ transform: `scaleX(${clamped})`, background: tone }} />
      </span>
    </div>
  );
}
