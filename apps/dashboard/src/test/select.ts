import { fireEvent, screen, within } from "@testing-library/react";

/** The custom `Select` is a button + listbox: open it by its label (or aria-label), then click the option. */
export function pickOption(label: string | RegExp, option: string | RegExp) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: option }));
}

/** The options a `Select` offers, opened by its label; it is closed again (Escape) afterwards. */
export function optionLabels(label: string | RegExp): string[] {
  const trigger = screen.getByLabelText(label);
  fireEvent.click(trigger);
  const names = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent ?? "");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  return names;
}

/** The text a `Select` shows (its trigger's current value). */
export function selectedText(label: string | RegExp): string {
  return screen.getByLabelText(label).textContent ?? "";
}
