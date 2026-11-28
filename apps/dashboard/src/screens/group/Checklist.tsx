import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-bold-duotone";
import { useCan } from "../../lib/member";
import type { Checklist as State } from "./problems";
import { groupPage as t } from "./strings";

/**
 * "Get this group ready": three steps (an app, people, a PC) for a group that still lacks one of them. A step that is done gets a
 * check and quiet words; the first one still open has the filled button. A viewer sees the same steps without buttons. The card
 * goes away by itself when all three are done.
 */
export function ReadyCard({ groupId, state, onAssign, onAddPeople }: { groupId: string; state: State; onAssign: () => void; onAddPeople: () => void }) {
  const admin = useCan("admin");
  const steps: { id: "apps" | "people" | "pcs"; done: boolean; text: { title: string; body: string }; action: (primary: boolean) => ReactNode }[] = [
    {
      id: "apps",
      done: state.apps,
      text: t.ready.apps,
      action: (primary) => (
        <Button variant={primary ? "primary" : "ghost"} onClick={onAssign}>
          {t.ready.apps.action}
        </Button>
      ),
    },
    {
      id: "people",
      done: state.people,
      text: t.ready.people,
      action: (primary) => (
        <Button variant={primary ? "primary" : "ghost"} onClick={onAddPeople}>
          {t.ready.people.action}
        </Button>
      ),
    },
    {
      id: "pcs",
      done: state.pcs,
      text: t.ready.pcs,
      // `/enrollment?group=` preselects this group on the Add a PC page.
      action: (primary) => (
        <Link className={`rb-btn rb-btn--${primary ? "primary" : "ghost"}`} to={`/enrollment?group=${encodeURIComponent(groupId)}`}>
          {t.ready.pcs.action}
        </Link>
      ),
    },
  ];
  const current = steps.find((s) => !s.done)?.id;

  return (
    <section className="grp-ready dash-enter" aria-labelledby="grp-ready-title">
      <div className="grp-ready__head">
        <h2 id="grp-ready-title" className="grp-ready__title">
          {t.ready.title}
        </h2>
        <span className="grp-ready__progress">{t.ready.progress(state.done)}</span>
      </div>
      <ol className="grp-ready__steps" aria-label={t.ready.stepsLabel}>
        {steps.map((s, i) => (
          <li key={s.id} className="grp-step" data-done={s.done || undefined} data-current={s.id === current || undefined}>
            <span className="grp-step__mark" aria-hidden="true">
              {s.done ? <IconCheck /> : i + 1}
            </span>
            <div className="grp-step__text">
              <p className="grp-step__title">
                {s.text.title}
                {s.done ? <span className="dash-sr"> ({t.ready.done})</span> : null}
              </p>
              <p className="grp-step__body">{s.text.body}</p>
            </div>
            {!s.done && admin ? <div className="grp-step__action">{s.action(s.id === current)}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
