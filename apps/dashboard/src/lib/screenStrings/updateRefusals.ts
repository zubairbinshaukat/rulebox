/**
 * The sentences for the refusals of the update modes (Phase 6, plan 4.4). The App screen registers them with
 * `registerDetailSentences` (lib/errors.ts) when its chunk loads, so they are not part of the first load.
 */
export const updateRefusalStrings = {
  vendor_mode_needs_publisher: "Give the publisher the installer is signed with. The program can only update itself when Rulebox knows who signs it.",
  publisher_too_broad: "That publisher is one of Windows' own signers. Add the product name so the rule does not allow most of Windows.",
  min_above_bootstrap: "The lowest version to keep can't be higher than the version this installer delivers.",
  version_not_ordered: "Use up to four numbers separated by dots, like 2.4.1, so Rulebox can tell which version is newer.",
} as const;
