import type { SelectOption } from "@rulebox/ui";
import { IDLE_CLOSE_CHOICES, displayStrings as s } from "../../lib/screenStrings/display";

/** The three display-mode choices of a group. */
export const MODE_OPTIONS: SelectOption[] = [
  { value: "auto", label: s.modeAuto },
  { value: "standard", label: s.modeStandard },
  { value: "lite", label: s.modeLite },
];

/**
 * Idle close: the default, off (0) and the usual times. A stored value the list does not know (set through the API) is added, so the
 * select never shows a value that is not what the server holds. The default is the empty value.
 */
export function idleCloseOptions(current: number | null, min: number, max: number): SelectOption[] {
  const times: number[] = IDLE_CLOSE_CHOICES.filter((m) => m >= min && m <= max);
  if (current !== null && current !== 0 && !times.includes(current)) times.push(current);
  times.sort((a, b) => a - b);
  return [{ value: "", label: s.idleDefault }, { value: "0", label: s.idleOff }, ...times.map((m) => ({ value: String(m), label: s.idleOption(m) }))];
}

/** The web window limit: the default, then 1 to `max` windows. */
export function windowCapOptions(min: number, max: number): SelectOption[] {
  return [{ value: "", label: s.capDefault }, ...Array.from({ length: max - min + 1 }, (_, i) => ({ value: String(min + i), label: s.capOption(min + i) }))];
}
