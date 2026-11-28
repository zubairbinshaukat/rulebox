import type { SelectOption } from "@rulebox/ui";

/** The presets, plus the stored value as one more option when it is not one of them (it is saved unchanged unless another is picked). */
export function presetOptions(presets: readonly number[], stored: number, label: (n: number) => string): SelectOption[] {
  const all = presets.includes(stored) ? presets : [...presets, stored].sort((a, b) => a - b);
  return all.map((n) => ({ value: String(n), label: label(n) }));
}
