import { Button } from "@rulebox/ui";
import IconRocket from "~icons/solar/rocket-2-linear";
import type { RolloutView } from "../../data/types";
import { useCan } from "../../lib/member";
import { rolloutStrings as s } from "./strings";

/**
 * The page while the staged rollout is off: one card that says what it is for and one main action, "Turn on", which asks which PCs go
 * first. A group with no PCs gets the reason instead of a button that cannot work. A viewer reads one sentence.
 */
export function TurnOnCard({ view, onTurnOn }: { view: RolloutView; onTurnOn: () => void }) {
  const canAct = useCan("admin");
  const noPcs = view.devices.length === 0;
  return (
    <section className="dash-card ro-hero" aria-labelledby="ro-hero-title">
      <div className="ro-hero__in">
      <span className="ro-hero__art" aria-hidden="true">
        <span className="ro-hero__icon">
          <IconRocket />
        </span>
        <span className="ro-hero__steps">
          {s.heroSteps.map((step) => (
            <span key={step} className="ro-hero__step">
              <i />
              <span>{step}</span>
            </span>
          ))}
        </span>
      </span>
      <div className="ro-hero__text">
        <h2 id="ro-hero-title" className="ro-hero__title">
          {s.heroTitle}
        </h2>
        <p className="ro-hero__body">{canAct ? s.heroBody : s.heroViewer}</p>
        {canAct ? (
          <div className="ro-hero__action">
            <Button disabled={noPcs} onClick={onTurnOn}>
              {s.turnOn}
            </Button>
            {noPcs ? <span className="ro-note">{s.turnOnNoPcs}</span> : null}
          </div>
        ) : null}
      </div>
      </div>
    </section>
  );
}
