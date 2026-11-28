import { InfoTip, Pill } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-linear";
import { settingsStrings } from "../../lib/screenStrings/settings";
import { ASKS_PIN, type SectionId } from "./sections";

const s = settingsStrings;

/** "Asks for your PIN": the pill that replaces the long "changing this asks you to confirm" sentences. */
export function AsksPin() {
  return (
    <span className="set-pin">
      <Pill tone="accent">
        <IconLock aria-hidden="true" />
        {s.asksPin}
      </Pill>
      <InfoTip label={s.asksPinInfoLabel} placement="bottom">
        {s.asksPinInfo}
      </InfoTip>
    </span>
  );
}

/** The heading of the open section: its name, one short line and, when it asks for the PIN, the pill. */
export function SectionHead({ id }: { id: SectionId }) {
  return (
    <header className="set-head">
      <div className="set-head__text">
        <h2 className="set-head__title">{s.nav.items[id]}</h2>
        <p className="set-head__lead">{s.leads[id]}</p>
      </div>
      {ASKS_PIN.has(id) ? <AsksPin /> : null}
    </header>
  );
}
