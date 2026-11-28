// The sections of Settings (UI pass, `docs/plans/ui-pass/settings.md` section 3): ids (the `?tab=` values, never renamed), groups and
// order. Pure data, so the shell, the navigation and the tests agree.

export const SECTION_IDS = ["organization", "members", "security", "adminExit", "updates", "signing", "about"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const GROUP_IDS = ["organization", "account", "pcs", "system"] as const;
export type GroupId = (typeof GROUP_IDS)[number];

/** Groups in the order they show, each with its sections (what people change most first, rare and risky last). */
export const GROUPS: readonly { id: GroupId; sections: readonly SectionId[] }[] = [
  { id: "organization", sections: ["organization", "members"] },
  { id: "account", sections: ["security"] },
  { id: "pcs", sections: ["adminExit", "updates"] },
  { id: "system", sections: ["signing", "about"] },
];

/** Sections only an Owner can change (everyone sees the lock in the navigation). */
export const OWNER_ONLY: ReadonlySet<SectionId> = new Set<SectionId>(["updates", "signing"]);

/** Sections whose changes ask for a fresh PIN or passkey (the "Asks for your PIN" pill). */
export const ASKS_PIN: ReadonlySet<SectionId> = new Set<SectionId>(["adminExit", "updates", "signing"]);

export function isSectionId(value: string | null): value is SectionId {
  return value !== null && (SECTION_IDS as readonly string[]).includes(value);
}

/** The address of a section: General has no `?tab=`. Other parameters are dropped on purpose (Members' page, sort, search). */
export function sectionSearch(id: SectionId): string {
  return id === "organization" ? "" : `?tab=${id}`;
}
