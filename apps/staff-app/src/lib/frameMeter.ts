import { call, isTauri } from "./tauri";

/** What one measured span looked like (plan Step 17). */
export interface FrameReport {
  name: string;
  frames: number;
  avgMs: number;
  worstMs: number;
  over32ms: number;
}

/** Debug builds only: Rust adds `window.__RB_DEBUG__` to the shell pages. */
export function frameMeterEnabled(): boolean {
  return (window as { __RB_DEBUG__?: boolean }).__RB_DEBUG__ === true;
}

/** Pure: the report for a list of gaps between animation frames. */
export function summarize(name: string, gaps: readonly number[]): FrameReport {
  const frames = gaps.length;
  const total = gaps.reduce((sum, gap) => sum + gap, 0);
  return {
    name,
    frames,
    avgMs: frames === 0 ? 0 : Math.round((total / frames) * 10) / 10,
    worstMs: Math.round(gaps.reduce((worst, gap) => Math.max(worst, gap), 0) * 10) / 10,
    over32ms: gaps.filter((gap) => gap > 32).length,
  };
}

/** A line for the console and, in the shell, for the log file. */
export function note(text: string): void {
  if (!frameMeterEnabled()) {
    return;
  }
  console.info(text);
  if (isTauri()) {
    void call("dev_note", { text }).catch(() => {});
  }
}

/**
 * Count the gaps between `requestAnimationFrame` calls until the returned
 * function is called, then report them. Does nothing outside debug builds.
 */
export function startFrameMeter(name: string): () => FrameReport | null {
  if (!frameMeterEnabled()) {
    return () => null;
  }
  const gaps: number[] = [];
  let last: number | null = null;
  let id = 0;
  const tick = (now: number) => {
    if (last !== null) {
      gaps.push(now - last);
    }
    last = now;
    id = window.requestAnimationFrame(tick);
  };
  id = window.requestAnimationFrame(tick);
  return () => {
    window.cancelAnimationFrame(id);
    const report = summarize(name, gaps);
    note(`frames ${JSON.stringify(report)}`);
    return report;
  };
}
