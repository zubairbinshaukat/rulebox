import { IDLE_CLOSE_CHOICES, displayStrings as s } from "../../lib/screenStrings/display";

/** The three display-mode choices as `<option>`s. */
export function ModeOptions() {
  return (
    <>
      <option value="auto">{s.modeAuto}</option>
      <option value="standard">{s.modeStandard}</option>
      <option value="lite">{s.modeLite}</option>
    </>
  );
}

/**
 * Idle close: the default, off (0) and the usual times. A stored value the list does not know (set through the API) is added, so the
 * select never shows a value that is not what the server holds.
 */
export function IdleCloseOptions({ current, min, max }: { current: number | null; min: number; max: number }) {
  const times: number[] = IDLE_CLOSE_CHOICES.filter((m) => m >= min && m <= max);
  if (current !== null && current !== 0 && !times.includes(current)) times.push(current);
  times.sort((a, b) => a - b);
  return (
    <>
      <option value="">{s.idleDefault}</option>
      <option value="0">{s.idleOff}</option>
      {times.map((m) => (
        <option key={m} value={m}>
          {s.idleOption(m)}
        </option>
      ))}
    </>
  );
}
