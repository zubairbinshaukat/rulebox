import type { ReactElement } from "react";
import { Button } from "@rulebox/ui";
import IconBasic from "~icons/solar/shield-minimalistic-linear";
import IconStandard from "~icons/solar/shield-check-linear";
import IconStrict from "~icons/solar/shield-keyhole-linear";
import type { LockdownSettings } from "../../data/types";
import { PRESET_IDS, presetOf, type PresetId } from "./presets";
import { RadioCards, type RadioCardOption } from "./RadioCards";
import { LkSection } from "./Section";
import { lockdownStrings as s } from "./strings";

const ICONS: Record<PresetId, ReactElement> = { basic: <IconBasic />, standard: <IconStandard />, strict: <IconStrict /> };

const OPTIONS: readonly RadioCardOption<PresetId>[] = PRESET_IDS.map((id) => {
  const text: { name: string; lead: string; points: string[]; badge?: string } = s.presets[id];
  return { value: id, title: text.name, lead: text.lead, points: text.points, badge: text.badge, icon: ICONS[id] };
});

/**
 * "Protection level": three cards (Basic, Standard, Strict). Nothing is stored: the level is read from the settings (`presetOf`), so a
 * group that was set up by hand reads "Custom: Standard with 2 changes", with Reset and a way to see the changes in Advanced.
 */
export function PresetPicker({
  settings,
  onPick,
  onShowChanges,
  disabled,
  className,
}: {
  /** The settings as they would be saved. */
  settings: LockdownSettings;
  onPick: (id: PresetId) => void;
  onShowChanges: () => void;
  disabled: boolean;
  className?: string;
}) {
  const match = presetOf(settings);
  const name = s.presets[match.nearest].name;
  return (
    <LkSection title={s.levelTitle} info={s.levelInfo} className={className}>
      {(headingId) => (
        <>
          <RadioCards variant="level" labelledBy={headingId} value={match.id === "custom" ? null : match.id} nearest={match.id === "custom" ? match.nearest : null} options={OPTIONS} onChange={onPick} disabled={disabled} />
          {match.id === "custom" ? (
            <div className="lk-custom" role="status">
              <p className="lk-custom__text">{s.custom(name, match.changes.length)}</p>
              <div className="lk-custom__actions">
                <Button variant="ghost" className="dash-btn--sm" onClick={onShowChanges}>
                  {s.customShow}
                </Button>
                {disabled ? null : (
                  <Button variant="ghost" className="dash-btn--sm" onClick={() => onPick(match.nearest)}>
                    {s.customReset(name)}
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </LkSection>
  );
}
