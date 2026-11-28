import type { CSSProperties } from "react";
import { FieldSet } from "../../components/Field";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { HUES } from "./appForm";

const s = appEditStrings;

/** The twelve tile colours as swatches (a radio group). Rulebox picks one by itself; this is for a person who wants another. */
export function HuePicker({ value, onChange, name, disabled = false }: { value: number | undefined; onChange: (h: number) => void; name: string; disabled?: boolean }) {
  return (
    <FieldSet legend={s.hue} info={s.info.hue}>
      <div className="dash-hue" role="radiogroup" aria-label={s.hue}>
        {HUES.map((h) => (
          <label key={h} className="dash-hue__swatch" style={{ "--h": h } as CSSProperties} title={`${s.hue} ${h}`}>
            <input type="radio" className="dash-sr" name={name} checked={value === h} disabled={disabled} onChange={() => onChange(h)} aria-label={`${s.hue} ${h}°`} />
          </label>
        ))}
      </div>
    </FieldSet>
  );
}
