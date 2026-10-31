import type { NoticeTone } from "@rulebox/types";

import { DEV_TOOLS_BUILD } from "../../lib/devMotion";
import { call } from "../../lib/tauri";
import "./toast.css";

const SAMPLES: { label: string; tone: NoticeTone; title: string; detail: string | null }[] = [
  { label: "Info", tone: "neutral", title: "This is a test notice", detail: "It also lands in the bell list." },
  { label: "Saved", tone: "success", title: "Saved Quarterly report.xlsx", detail: "Batwa" },
  {
    label: "Warning",
    tone: "warning",
    title: "Files ending in .exe aren't allowed on this PC.",
    detail: "Ask your administrator if you need this file.",
  },
  { label: "Error", tone: "danger", title: "The download did not finish.", detail: "Zubyr" },
];

/**
 * Debug builds only (resource monitor popup): post notices to see the toast
 * cards: one of each tone, and four at once (the fourth pushes the first out).
 * Does nothing in a release build.
 */
export function DevToastButtons() {
  if (!DEV_TOOLS_BUILD) {
    return null;
  }
  const post = (sample: (typeof SAMPLES)[number], stamp = "") =>
    call("dev_toast", { tone: sample.tone, title: sample.title + stamp, detail: sample.detail }).catch(() => undefined);
  const burst = () => {
    SAMPLES.forEach((sample, index) => {
      window.setTimeout(() => void post(sample, ` (${index + 1})`), index * 350);
    });
  };
  return (
    <div className="rb-dev-toasts">
      <span className="rb-dev-toasts__label">Test toast</span>
      <div className="rb-dev-toasts__row">
        {SAMPLES.map((sample) => (
          <button key={sample.label} type="button" className="rb-dev-toasts__button" onClick={() => void post(sample)}>
            {sample.label}
          </button>
        ))}
        <button type="button" className="rb-dev-toasts__button" onClick={burst}>
          Four
        </button>
      </div>
    </div>
  );
}
