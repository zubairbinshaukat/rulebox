import { useCallback, useEffect, useState } from "react";
import { LogoMotion, setLite } from "@rulebox/ui";

import { note, startFrameMeter } from "../../lib/frameMeter";
import type { MotionLevel } from "../../lib/motion";
import { useLogoSequence, type LogoKind } from "../boot/useLogoSequence";

/**
 * Debug bench (plan Step 17): plays the splash, loading, open and lock logos
 * one after another, in full motion and then in Lite, through the same
 * `useLogoSequence` the shell uses, and logs the frame meter and which path
 * (animation callback or fallback timer) ended each step. Built only with
 * `VITE_RB_BENCH=1`; opened with `RULEBOX_BENCH_LOGO=1` on a debug build.
 */

const LOADING_MS = 10_000;
const START_DELAY_MS = 5_000;
const GAP_MS = 600;

type Job = { kind: LogoKind | "loading"; level: MotionLevel };

const JOBS: Job[] = (["full", "fade"] as const).flatMap((level) => [
  { kind: "splash", level } as Job,
  { kind: "loading", level } as Job,
  { kind: "open", level } as Job,
  { kind: "lock", level } as Job,
]);

interface StepProps {
  index: number;
  level: MotionLevel;
  /** Move on to the job after `index` (a repeat call is ignored). */
  advance: (index: number) => void;
}

function Sequence({ kind, index, level, advance }: StepProps & { kind: LogoKind }) {
  const seq = useLogoSequence(kind, level, true);
  useEffect(() => {
    if (seq.done) {
      advance(index);
    }
  }, [seq.done, advance, index]);
  return <LogoMotion key={seq.key} animation={seq.animation} onCovered={seq.onCovered} onDone={seq.onDone} />;
}

function Loading({ index, level, advance }: StepProps) {
  useEffect(() => {
    const stop = startFrameMeter(`loading:${level}`);
    const id = window.setTimeout(() => advance(index), LOADING_MS);
    return () => {
      window.clearTimeout(id);
      stop();
    };
  }, [index, level, advance]);
  return <LogoMotion animation="loading" />;
}

export default function LogoBench() {
  // -1: waiting to start; JOBS.length: finished.
  const [at, setAt] = useState(-1);

  useEffect(() => {
    note(`bench-logo: starting in ${START_DELAY_MS} ms at ${window.innerWidth}x${window.innerHeight}`);
    const id = window.setTimeout(() => setAt(0), START_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  const advance = useCallback((from: number) => {
    window.setTimeout(() => setAt((n) => (n === from ? n + 1 : n)), GAP_MS);
  }, []);

  const job = JOBS[at];
  const level = job?.level;
  useEffect(() => {
    if (level) {
      setLite(level === "fade");
    }
  }, [level]);

  useEffect(() => {
    if (at === JOBS.length) {
      note("bench-logo: finished");
    }
  }, [at]);

  if (!job) {
    return null;
  }
  return (
    <div
      style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--rb-bg)" }}
    >
      {job.kind === "loading" ? (
        <Loading key={at} index={at} level={job.level} advance={advance} />
      ) : (
        <Sequence key={at} kind={job.kind} index={at} level={job.level} advance={advance} />
      )}
    </div>
  );
}
