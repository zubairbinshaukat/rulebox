import type { ReactNode } from "react";
import IconChecked from "~icons/solar/check-circle-bold-duotone";
import "./ToggleChip.css";

export interface ToggleChipProps {
  pressed: boolean;
  onToggle: () => void;
  /** A Solar icon before the label (decorative). */
  icon?: ReactNode;
  children: ReactNode;
  /** The full name on hover ("Word: .docx, .doc"). */
  title?: string;
  disabled?: boolean;
}

/**
 * A small on/off choice drawn as a chip ("Taskbar", "PDF"). A real button with `aria-pressed`, so Tab, Space and Enter work and a
 * screen reader says "pressed". A pressed chip has the accent edge and a check mark; the state is never colour alone.
 * Put several in a `.dash-tchips` row (it wraps).
 */
export function ToggleChip({ pressed, onToggle, icon, children, title, disabled }: ToggleChipProps) {
  return (
    <button type="button" className="dash-tchip" aria-pressed={pressed} title={title} disabled={disabled} onClick={onToggle}>
      {pressed ? (
        <span className="dash-tchip__icon dash-tchip__icon--on" aria-hidden="true">
          <IconChecked />
        </span>
      ) : icon ? (
        <span className="dash-tchip__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="dash-tchip__label">{children}</span>
    </button>
  );
}
