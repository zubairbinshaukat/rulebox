import type { SelectOption } from "@rulebox/ui";
import type { AppKind } from "../data/types";
import { AppGlyph } from "./AppGlyph";
import "./appOptions.css";

/** The kind of an app in words a person uses: shown under its name in a picker. */
const KIND_WORDS: Record<AppKind, string> = { web: "Website", desktop: "Windows app" };

/**
 * The options of an app picker (`SearchSelect`): the app's letter tile, its name, and "Website" or "Windows app" under it.
 * `apps:options` carries no colour or icon, so the tile is the neutral one; the app's own tile shows on its page and in lists.
 */
export function appSelectOptions(apps: readonly { _id: string; name: string; kind: AppKind }[]): SelectOption[] {
  return apps.map((a) => ({
    value: a._id,
    label: a.name,
    hint: KIND_WORDS[a.kind],
    icon: <AppGlyph name={a.name} kind={a.kind} />,
  }));
}
