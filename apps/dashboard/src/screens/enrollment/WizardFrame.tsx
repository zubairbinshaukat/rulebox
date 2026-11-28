import { useEffect, useId, useRef, type ReactNode } from "react";
import IconCheck from "~icons/solar/check-read-linear";
import { enrollText as s } from "./strings";

export type WizardStep = 1 | 2 | 3;

const LABELS: Record<WizardStep, string> = { 1: s.steps.create, 2: s.steps.install, 3: s.steps.done };

/** The three steps: numbered dots joined by a line (a row from 520 px, a column below). */
export function Stepper({ current, summary }: { current: WizardStep; summary?: string }) {
  return (
    <ol className="addpc-steps" aria-label={s.stepsLabel}>
      {([1, 2, 3] as const).map((n) => {
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li key={n} className="addpc-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="addpc-step__dot" aria-hidden="true">
              {state === "done" ? <IconCheck /> : n}
            </span>
            <span className="addpc-step__text">
              <span className="addpc-step__label">{LABELS[n]}</span>
              {n === 1 && state === "done" && summary ? <span className="addpc-step__sub">{summary}</span> : null}
              <span className="dash-sr">{`, ${s.stepState[state]}`}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export interface WizardFrameProps {
  step: WizardStep;
  /** The heading of the step (an `h2`). */
  heading: ReactNode;
  /** Step 1 in the stepper's summary once it is done ("Front desk · 1 PC"). */
  summary?: string;
  /** The person just did something that brought them here: the heading takes the focus (never on page load). */
  focus?: boolean;
  /** A sentence for screen readers when the step changes by itself (a PC joined). */
  announce?: string;
  children: ReactNode;
}

/**
 * The card around every step: the stepper on top, then the step's own body. A change of step enters with the shared CSS entrance
 * (opacity and transform only) and is announced politely; the focus moves to the heading only after the person's own action.
 */
export function WizardFrame({ step, heading, summary, focus = false, announce, children }: WizardFrameProps) {
  const headingId = useId();
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) h.current?.focus();
    // Only when the step's component appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="dash-card addpc" aria-labelledby={headingId} data-step={step}>
      <div className="addpc__top">
        <Stepper current={step} summary={summary} />
      </div>
      <p className="dash-sr" role="status" aria-live="polite">
        {announce}
      </p>
      <div className="addpc__body dash-enter" key={step}>
        <h2 id={headingId} ref={h} tabIndex={-1} className="addpc__heading">
          {heading}
        </h2>
        {children}
      </div>
    </section>
  );
}

/** Pieces of the install step that are plain text with a leading numeral. */
export function HowTo({ lines }: { lines: readonly string[] }) {
  return (
    <ol className="addpc-how">
      {lines.map((line, i) => (
        <li key={line}>
          <span className="addpc-how__n" aria-hidden="true">
            {i + 1}
          </span>
          <span>{line}</span>
        </li>
      ))}
    </ol>
  );
}
