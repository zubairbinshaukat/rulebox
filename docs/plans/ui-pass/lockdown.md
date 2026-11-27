# UI pass: Lockdown page and Programs to review (2026-11-28)

Routes: `/groups/:id/lockdown` (screen `Lockdown.tsx`), `/lockdown/findings` (screen `Findings.tsx`), plus the WORDS of the
lockdown parts of `/devices/:id` (`lockdown/DeviceCards.tsx`, `deviceStrings.ts`, `codes.ts`) and the overview warning lines.
The device page LAYOUT belongs to `device-detail.md`; this plan changes only string files there.

Spec: `docs/plans/follow-ups.md` "0d", "Bug: Hide administrator accounts is ON by default", "Users are not technical",
"Automate the complex things", "4. Helper text"; contract: `docs/plans/ui-pass/README.md`; behaviour: PRD 12.2, 13.2 and
`docs/plans/phase-5-lockdown.md` 4.3, 4.6, 4.10, 4.14, 4.20. Data shapes do not change: **every field of
`lockdownSettings` keeps its name and values**; presets are derived on the client, never stored.

Out of bounds for this plan: `convex/lib/lockdownValidators.ts` defaults (another agent flips `hideAdminTiles` to `false` for new
groups), `apps/agent/`, `crates/`, `apps/dashboard/src/stepup/`, the layout of `DeviceCards.tsx`.

## 1. Inventory (today)

| # | Control / value | Field or source | File |
|---|---|---|---|
| 1 | "Allowed programs for employees (AppLocker)" Off/Audit/Enforce | `appLocker.mode` | `Lockdown.tsx` Form |
| 2 | "App Control" Off/Audit/Enforce | `appControl.mode` | same |
| 3 | "App Control level" Recommended blocks / Allow list only | `appControl.level` | same |
| 4 | "Process watch" Off/Audit/Enforce | `procWatch.mode` | same |
| 5 | USB drives and memory cards Allowed/Read only/Blocked | `usb.storage` | same, USB card |
| 6–9 | USB printers, Scanners and cameras, Phones, Other USB devices Allowed/Blocked | `usb.printers/imaging/phones/other` | same |
| 10 | "Also apply to devices that are already plugged in" | `usb.retroactive` | same |
| 11 | Fixed line "Keyboards, mice and touch screens always work." + warning when other = block | — | same |
| 12–21 | Employee restrictions: Task Manager, Run, command prompt, registry editor, Settings/Control Panel, Sign out, Change password, hide drives, accessibility shortcut keys, Office macros | `staff.*` (10 booleans) | same |
| 22–28 | PC restrictions: hide Switch user, hide sign-in power button, never ask for admin password, hide admin accounts, no password after sleep, only admins install printer drivers, hide print-to-file printers | `machine.hideSwitchUser, hideSignInPower, denyElevationRequests, hideAdminTiles, noWakePassword, restrictPrinterDrivers, fileOutputPrinters` | same |
| 29–32 | Lock account after wrong passwords (switch) + threshold, duration (min), window (min) | `machine.accountLockout` (`null` = leave) | same, `rules.ts` lockout draft |
| 33 | Block Windows-key shortcuts | `keyboard.winCombos` swallow/pass | same |
| 34 | Allow the Windows accessibility tools | `accessibilityTools` | same |
| 35 | Turn off automatic Windows recovery | `boot.autoRecovery` off/leave | same |
| 36 | Keep employees out of Safe Mode | `boot.safeModeGuard` | same |
| 37–39 | Tune Windows for employees, kiosk performance profile, "This group does not print" | `performance.staffTuning/kioskProfile/noPrinting` | same |
| 40 | Managed Wi-Fi networks only | `wifiManagedOnly` | same |
| 41 | "I understand this PC may go offline" | `wifiManagedOnlyConfirmed` | same |
| 42 | Notices: read-only, "Audit findings: N new" + Review link, audit ≥ 7 days | `openFindings(+More)`, `auditSince` | same |
| 43 | Save / Discard / "unsaved" hint / stale-edit Reload | `lockdown:update` (`expectedRevision`) | same |
| 44 | Confirm dialog for Enforce and managed Wi-Fi (findings count, App Control sentence) | `changedLayers`, `openFindings` | same |
| 45 | Exceptions list: what, kind, app, reason, date, "Breaks on update", Remove (+confirm), "newest 50" | `exceptions[]`, `lockdown:removeException` | `Lockdown.tsx` Exceptions |
| 46 | Findings status Open/Allowed/Ignored (`?status=`) | `lockdown:findings` status | `Findings.tsx` |
| 47 | Columns Program (+product), Signed by / Not signed, Found in, Rule (layer), PCs, Last seen | `FindingRow` | same |
| 48 | "Allow for app…" (disabled for App Control), Ignore (+confirm), empty states | `lockdown:allow`, `lockdown:ignore` | same |
| 49 | Allow dialog: rule kind (publisher/hash/path + reasons), folder template, groups (checkboxes, ≤ 100), program it belongs to, note | `lockdown:allow`, `lockdown:allowOptions` | `lockdown/AllowDialog.tsx` |
| 50 | Device: Physical protection rows (Secure Boot, BitLocker, auto recovery, Safe Mode, TPM, service protection, repairs) | `fleet:get.protection` | `DeviceCards.tsx`, `deviceStrings.ts` |
| 51 | Device: Lockdown card: state pill, refusal, Home note, 7 layers (mode · note · state), group config version, last working version | `fleet:get.apply` | same, `codes.ts` |
| 52 | Device: Rollout ring picker | `rollouts:setRings` | same |
| 53 | Device: Allow USB for this PC (1/2/4/8 h, End now) | `fleet:allowUsb` | same |
| 54 | Overview lines: audit > 14 days, rollout paused, policy not applied | `overview:get.lockdown` | `overview/LockdownAttention.tsx`, `overview/strings.ts` |

## 2. Classification

Legend: **P** = set by the protection level (preset) up front, **M** = the "Program blocking" control up front, **A** = Advanced,
**D** = one click deeper (dialog, (i), device page), **Auto** = filled for the user, **R** = removed.

| # | Class | Plain label | (i) text (short) | Reason |
|---|---|---|---|---|
| 1,2,4 | M (all three at once); A per check | Employee program list / Windows safety list / Rulebox program check | see section 8 | One decision ("report or block"), three engines is detail |
| 3 | P (Recommended list in every level); A to change | Safety list strength | "Recommended list" blocks known escape tools; "Strict list" allows only Windows and Program Files, also for admins | The strict list breaks PCs; never a one-click choice |
| 5–10 | P | USB drives…, Phones… | per row | Common question, but presets answer it |
| 11 | stays (fixed line in USB section) | Keyboards, mice and touch screens always work. | — | Reassurance, PRD rule |
| 12–21 | P | short labels (section 8) | the old hint text | Nobody needs to touch them one by one |
| 22,23,25–28 | P | short labels | the old hint | same |
| 24 `hideAdminTiles` | A only, NOT in any preset | Hide administrator accounts | "Administrators sign in with Other user…" | PC-dependent (E-71); the admin-accounts warning sits under it (section 7) |
| 29–32 | P (values), A (inputs) | Lock an account after wrong passwords; Wrong passwords allowed; Lock for (minutes); Count within (minutes) | numbers explained in (i) | Numbers are technical; presets fill them |
| 33,34 | P | Block Windows-key shortcuts; Allow Narrator, Magnifier and on-screen keyboard | old hints | — |
| 35,36 | P | Hide the Windows recovery screen; Keep employees out of Safe Mode | old hints | — |
| 37–39 | A only (Speed), not in presets | Make Windows lighter for employees; Turn off unneeded Windows services; This group does not print | old hints | Speed, not protection |
| 40,41 | A only (Wi-Fi), not in presets | Only this group's Wi-Fi networks; Apply even if a PC goes offline | old hints | Can cut PCs off; needs a network first |
| 42 | stays, reworded | "12 programs to review" card; "Trial run for 9 days" line | — | Guides the audit → block step |
| 43 | stays: sticky save bar | Save / Undo changes | — | One main action |
| 44 | stays, reworded | "Start blocking programs?" | — | PRD 4.20 text rule |
| 45 | stays (aside), reworded | Extra allowed programs | "Programs you allowed from the review list. The apps you assigned are always allowed." | — |
| 45 "Breaks on update", hash prefix | reworded / R | "Allow again after updates" pill; hash prefix removed from the row (kept in the row's `title`) | — | Technical value |
| 46 | stays as `PageTabs` (`?status=`) | To review / Allowed / Ignored | — | — |
| 47 Rule column | R as a column → D (sub line + (i) only for the Windows safety list) | — | "Windows blocks this one for everyone; it cannot be allowed one by one." | Layer names are jargon |
| 47 Signed by | merged into Program cell | "Contoso Ltd" / pill "Unknown publisher" | — | Fewer columns |
| 48 | stays, one main action per row | Allow / Ignore | — | — |
| 49 rule kind | Auto (best kind picked) + A (change it) | "Recognised by its publisher, Contoso Ltd." | per kind | Automate the complex thing |
| 49 folder | A, Auto-prefilled root (`{ProgramFiles}\` / `{RuleboxApps}\`) | Folder | template hint | Rare, technical |
| 49 groups | Auto-preselected (`?group=` or the only group) | Allow in | — | — |
| 49 program it belongs to, note | A | Belongs to app (optional); Note (optional) | — | Optional fields |
| 50 TPM, service protection, repairs | D (device-detail decides) | words only here | — | Technical |
| 51 version numbers, layer list | D (device-detail decides); words change here | "Settings version" / "Last working settings" | — | Technical |
| 52,53 | unchanged (device-detail) | — | — | — |
| 54 | reworded | "Trial run for more than 14 days: …" | — | Same words as the page |

## 3. Presets ("Protection level")

Pure module `apps/dashboard/src/screens/lockdown/presets.ts`. A preset sets exactly the **preset fields** below (28 values).
Everything else (program-rule modes, `machine.hideAdminTiles`, `performance.*`, `wifiManagedOnly`, `wifiManagedOnlyConfirmed`)
is left as it is in the draft.

| Field | Basic | Standard (Recommended) | Strict |
|---|---|---|---|
| staff.taskManager, run, commandPrompt, registryTools, officeMacros, accessibilityHotkeys | true | true | true |
| staff.settings, signOut, changePassword, hideDrives | false | true | true |
| machine.denyElevationRequests, noWakePassword, restrictPrinterDrivers | true | true | true |
| machine.hideSwitchUser, hideSignInPower, fileOutputPrinters | false | true | true |
| machine.accountLockout | `null` (leave the PC's own) | `{10, 15, 15}` | `{5, 30, 30}` |
| keyboard.winCombos | swallow | swallow | swallow |
| accessibilityTools | true | false | false |
| usb.storage | allow | allow | block |
| usb.printers, imaging, other | allow | allow | allow |
| usb.phones | allow | allow | block |
| usb.retroactive | false | false | true |
| boot.autoRecovery | leave | off | off |
| boot.safeModeGuard | true | true | true |
| appControl.level | recommendedBlocks | recommendedBlocks | recommendedBlocks |

- **Standard = today's `DEFAULT_LOCKDOWN_SETTINGS` on every preset field**, so every group that kept the defaults reads
  "Standard" (also after the other agent sets `hideAdminTiles: false`, since that field is not a preset field). A test pins this
  against the dashboard's `DEFAULT_LOCKDOWN_SETTINGS` copy in `data/types.ts`.
- Strict lockout `{5, 30, 30}`: 5 = `MIN_LOCKOUT_THRESHOLD`, window ≤ duration, so the agent's `lockout_threshold_too_low` and
  `lockout_window_too_long` can never fire for a preset.
- API: `PRESETS: Record<PresetId, PresetValues>`, `applyPreset(draft, id) → LockdownSettings`,
  `presetOf(settings) → { id: PresetId | "custom"; nearest: PresetId; changes: PresetField[] }` (exact match on the 28 values;
  `nearest` = fewest differences, ties prefer standard → basic → strict; `changes` = the differing fields of `nearest`),
  `PRESET_FIELDS` (path list), `fieldChanged(settings, nearest, path)`.
- **Custom**: no card is checked; a fourth row appears under the cards: "Custom: Standard with 2 changes" + "Reset to Standard"
  (applies `nearest`). In Advanced each control whose value differs from `nearest` shows a small "Changed" pill.
- **Home edition / unsupported features**: presets are the same on every edition. The PC reports `unsupported` per layer; the
  "Your PCs" card says "2 PCs run Windows Home: the employee program list does not work there. The Rulebox program check still
  does." (count from the same query, section 6). App Control allowlist with a per-user install is refused by the PC
  (`allowlist_level_with_user_install`) — only reachable via Advanced, so presets cannot trigger it.
- **Program blocking control** (M): `programModeOf(s) → "off" | "audit" | "enforce" | "mixed"` (all three equal or mixed);
  `setProgramMode(s, m)` sets all three. Mixed shows no option checked + "Set per check in Advanced".

## 4. Save flow

Saving already publishes (`lockdown:update` → `snapshotGroupConfig` → `requestPublish`); nothing changes on the server.

States:
1. **Clean**: no save bar. The "Your PCs" card shows the live state.
2. **Dirty**: sticky save bar at the bottom of the page: "3 unsaved changes" with an `InfoTip` listing the changed labels
   (`changeLabels(before, next)` in `rules.ts`, max 8 + "and N more"), "Undo changes" (ghost), "Save" (primary).
3. **Invalid** (lockout numbers): Save stays clickable; click marks touched, opens the Advanced `<details>`, scrolls to and
   focuses the first invalid input; inline errors as today. Nothing is sent.
4. **Confirm**: as today when a check moves to Block or managed Wi-Fi turns on (dialog words in section 8).
5. **Step-up**: unchanged. A change of any program-rule mode or of the safety list strength is MAJOR on the server
   (`requireStepUp("fresh")`); `useMapped` → `withStepUp` opens the PIN dialog and retries. Preset changes never touch modes; they
   touch `appControl.level` only when leaving a Custom "Strict list", which also asks for the PIN. Cancelling the PIN keeps the
   draft and shows the usual error.
6. **Saving**: button "Saving…", controls disabled.
7. **Saved**: toast `saved` = "Saved. Your PCs get this within a minute." (rings on: `savedRings` = "Saved. Pilot PCs get this
   within a minute; the others when the rollout moves on."; chosen from `groupSync.ringsOn`, generic text while it loads). The
   "Your PCs" card turns to "Sending: 0 of 8 PCs have it" and counts up live (its query re-runs as PCs report); at n = m it shows
   "All 8 PCs are up to date." No Publish button anywhere.
8. **Errors**: `FormError` above the save bar as today: `stale_edit` (Reload), `managed_networks_empty`, bad lockout, forbidden.

**"PCs up to date: n of m" data path** — new query `lockdown:groupSync` (section 6), fed by tables that exist today:
`devices.by_group` (m) and `deviceApplyReports.by_org_config` (n; the agent writes its one report row only when its content
hash changes). The newest version is `max(groupRollouts.pointers)` (the rollout row is ~1.5 KB; configuration texts are never
read). A PC counts as up to date when its report names this group, a version ≥ newest, and state `applied` or `partial`
(`partial` = it got the settings with notes; Home PCs would never count otherwise). `refused | failed | rolledBack` count as
"could not apply"; the rest is "waiting" (offline, busy, or never reported). No new counter: see decision D9 for why and for
the fallback.

## 5. Layout per band

Page CSS: `src/screens/lockdown/lockdown.css` (imported by `Lockdown.tsx` and `Findings.tsx`). Tokens only. The progress bar
animates with `transform: scaleX()` + `opacity` only; no transition under reduced motion or Lite.

Lockdown page:
- **phone (< 600)**: one column, 16 px gutter. Order: "Your PCs" strip (one line + bar; tap expands details), Protection level
  (three stacked radio rows), Program blocking (three stacked radio rows), "Programs to review" row link, Advanced (closed),
  Extra allowed programs, sticky save bar (full width, safe-area padding).
- **tablet (600–1023)**: one column; preset cards three across when the container is ≥ 720 px (container query), else stacked;
  Advanced sections in 2 columns; aside cards (Your PCs, Programs to review, Extra allowed programs) as a 2-column grid under
  the header, Your PCs first.
- **laptop (1024–1599)**: `dash-split` main 2 : aside 1. Main: Protection level (3 cards in a row), Program blocking (radio cards
  in a row + selected description), Advanced (2 columns when open). Aside (sticky top): Your PCs, Programs to review, Extra
  allowed programs.
- **wide (≥ 1600)**: same split inside `dash-page` max 1480; Advanced 2 columns in main (main is ~950 px), aside cards wider.
- Advanced: `dash-advanced` `<details>` "Advanced settings", closed by default (opens on an error or on "Show changes" in the
  Custom row). Inside: section cards in a CSS multi-column (`column-width: 320px; column-gap`, `break-inside: avoid`), so short
  and tall sections pack without holes.

```
LAPTOP 1366 — /groups/:id/lockdown
┌ nav ┐ ← Back to the group
│     │ Lockdown · Pharmacy counter
│     │ What employees can and cannot do on this group's PCs.
│     │ ┌──────────────────── main ────────────────────────┐ ┌──────── aside ──────────┐
│     │ │ Protection level (i)                              │ │ Your PCs                │
│     │ │ ┌───────────┐ ┌────────────────┐ ┌───────────┐   │ │ PCs up to date: 2 of 5  │
│     │ │ │ ○ Basic   │ │ ● Standard     │ │ ○ Strict  │   │ │ ██████░░░░░░░░░░░░      │
│     │ │ │ Hides the │ │  Recommended   │ │ For public│   │ │ 2 waiting (i)           │
│     │ │ │ risky     │ │ The usual kiosk│ │ PCs. Also │   │ │ ⚠ 1 could not apply it: │
│     │ │ │ tools     │ │ lockdown       │ │ blocks USB│   │ │   COUNTER-03 →          │
│     │ │ │ • USB ok  │ │ • USB drives ok│ │ • USB off │   │ │ Rings on: pilot first → │
│     │ │ └───────────┘ └────────────────┘ └───────────┘   │ │ [admin-accounts slot]   │
│     │ │ Program blocking (i)                              │ ├─────────────────────────┤
│     │ │ ┌────────┐ ┌──────────────────────┐ ┌─────────┐  │ │ Programs to review   12 │
│     │ │ │ ○ Off  │ │ ● Trial run          │ │ ○ Block │  │ │ Allow what employees    │
│     │ │ │        │ │   only report        │ │         │  │ │ need. [Review programs] │
│     │ │ └────────┘ └──────────────────────┘ └─────────┘  │ ├─────────────────────────┤
│     │ │ Nothing is blocked yet. Trial run for 9 days.     │ │ Extra allowed programs  │
│     │ │ ▸ Advanced settings                               │ │ tool.exe · Contoso [Rm] │
│     │ └───────────────────────────────────────────────────┘ └─────────────────────────┘
│     │ ┌ sticky (only with changes) ─────────────────────────────────────────────────┐
│     │ │ 3 unsaved changes (i)                          [Undo changes]   [ Save ]     │
└─────┘ └──────────────────────────────────────────────────────────────────────────────┘

PHONE 390 — /groups/:id/lockdown
≡ Rulebox
← Back to the group
Lockdown · Pharmacy counter
┌──────────────────────────────┐
│ PCs up to date: 2 of 5     ▾ │
│ ██████░░░░░░░░░░             │
└──────────────────────────────┘
Protection level (i)
┌──────────────────────────────┐
│ ○ Basic   Hides risky tools  │
│ ● Standard  Recommended      │
│ ○ Strict  Also blocks USB    │
└──────────────────────────────┘
Program blocking (i)
│ ○ Off │ ● Trial run │ ○ Block │  (stacked rows < 420 px)
┌ Programs to review: 12     › ┐
▸ Advanced settings
Extra allowed programs …
┌──────── sticky ──────────────┐
│ 3 changes   [Undo]  [ Save ] │
└──────────────────────────────┘
```

Findings page ("Programs to review"):
- `PageTabs` + `useUrlTab(["new","allowed","ignored"], "new", "status")` (keeps today's `?status=` URLs). `ServerTable` stays
  (it gets the shared Cards view from `lists-and-cards.md`; on phone its card layout). Columns: Program (name; publisher or
  "Unknown publisher" pill; product as sub line), Found in (plain folder words), PCs, Last seen, Actions.
- phone: one column of cards: name, publisher, "3 PCs · 1 hour ago · In the employee's own folders", actions row
  `[Allow] [Ignore]`; the "How to review" box collapses into an `InfoTip` next to the title.
- tablet: table (or cards per the shared switch); "How to review" as a one-line strip above the list.
- laptop / wide: `dash-split`: list (2/3) + aside "How to review" (3 numbered steps + link back to the group when `?group=`).

```
LAPTOP 1366 — /lockdown/findings
Programs to review
Programs your PCs stopped, or would stop in a trial run. Allow what employees need.
[ To review ][ Allowed ][ Ignored ]
┌──────────────────────── list ─────────────────────────────┐ ┌──── How to review ───┐
│ Program                Found in              PCs  Seen     │ │ 1 Allow what your    │
│ tool.exe               Employee's own        3    1 h ago  │ │   employees need.    │
│ Contoso Ltd · Tool     folders              [Allow][Ignore]│ │ 2 Ignore the rest.   │
│ notes.exe              USB drive             1    2 days   │ │ 3 Switch the group   │
│ ⚠ Unknown publisher                         [Allow][Ignore]│ │   to Block.          │
│ driver-tool.exe        Program Files         3    3 days   │ │ [Back to Pharmacy    │
│ Windows safety list (i)                          [Ignore] │ │  counter]            │
│ ── Page 1 · Next › ──                                      │ └──────────────────────┘
└────────────────────────────────────────────────────────────┘

PHONE 390 — /lockdown/findings
Programs to review (i)
[To review][Allowed][Ignored]  (scrolls sideways)
┌──────────────────────────────┐
│ tool.exe                     │
│ Contoso Ltd                  │
│ 3 PCs · 1 hour ago           │
│ In the employee's own folders│
│ [ Allow ]          [ Ignore ]│
└──────────────────────────────┘
```

Allow dialog (all bands; `Modal wide` on laptop+, full-height sheet on phone):

```
Allow tool.exe
Employees in the chosen groups can start this program.
Recognised by its publisher, Contoso Ltd. Keeps working after updates. (i)
Allow in   [x] Pharmacy counter  [ ] Front desk  [ ] Back office      (filter box when > 8 groups)
▸ Advanced: How to recognise it [Select] · Folder (path only) · Belongs to app [SearchSelect] · Note
                                                            [Cancel] [ Allow ]
```

## 6. Data

New query **`lockdown:groupSync`** (viewer) in `convex/lockdown.ts`:

```ts
args: { groupId: v.string() }
returns: v.object({
  total: v.number(), totalMore: v.boolean(),          // PCs in the group, capped at LOCKDOWN_SYNC_CAP
  upToDate: v.number(), problems: v.number(),
  problemPcs: v.array(v.object({ deviceId: v.id("devices"), name: v.string(), state: applyState })), // <= 3
  reduced: v.number(),                                 // appLocker or appControl layer "unsupported" (Home)
  adminTilesPending: v.number(),                       // section 7
  newestVersion: v.union(v.number(), v.null()),        // null = no configuration version yet
  ringsOn: v.boolean(), rolloutState: rolloutState,    // idle | rolling | halted
})
```

Handler: `getInOrg` group → `groupRollouts.by_group` `.unique()` → `devices.by_group` `.take(LOCKDOWN_SYNC_CAP + 1)` →
`deviceApplyReports.by_org_config` `.eq("orgId").eq("config.groupId", group._id)` `.take(LOCKDOWN_SYNC_CAP + 1)`; count only
reports whose `deviceId` is among the group's PCs (a PC that moved away keeps a stale report until it re-applies). Newest =
`max(pointers.pilot, early, everyone)`; no rollout row → `newestVersion: null`, `upToDate: 0`. New constant
`LOCKDOWN_SYNC_CAP = 200` in `convex/lib/limits.ts` (same size as `RING_COUNT_CAP`). No new index, no schema change.

- Reads per run: wrapper 3 + group 1 + rollout 1 + ≤ 201 PCs (~0.5–1.5 KB) + ≤ 201 reports (~2.5 KB) ≈ **407 reads,
  ≤ 850 KB**. A free tenant (2 PCs) reads ~9 docs / ~8 KB.
- Re-runs: when a PC row of the group, the rollout row or one of the group's apply reports changes. Reports change only when a
  PC's applied state changes (content hash), so normally zero re-runs; after a save, about one per PC (that IS the live
  counter). Never on a heartbeat or ping (liveness lives elsewhere). Subscribed only while the lockdown page is open; a
  separate query so `groupView` (the form) does not re-run on reports — the same split as `rollouts:groupView` / `health`.
- `convex/ioBudgets.ts`: `"lockdown:groupSync": { maxReads: 3 + 1 + 1 + 201 + 201, maxReadBytes: 850_000, maxWrites: 0,
  maxWriteBytes: 0, live: true }` with the comment above (UNSURE until measured, like the other Step 19 rows).
- Unchanged: `lockdown:groupView`, `update`, `findings`, `allowOptions`, `allow`, `ignore`, `removeException`, `fleet:get`.

Data seam:
- `data/types.ts`: `LockdownSync` (the shape above, ids as `Id`).
- `data/lockdown/api.ts`: `useLockdownSync: (groupId: Id) => QueryState<LockdownSync>`; `index.ts` exports it.
- `data/lockdown/live.ts`: `useMemberQuery(api.lockdown.groupSync, { groupId })` (the `lockdown` module exists, so
  `_generated/api` types pick it up without `convex dev`).
- `data/demo/lockdown.ts`: `syncOf(db, groupId)` with the same rules over `db.devices`, `db.applyDetails` (`configVersion`,
  `state`, layers) and `db.rollouts`; key `lockdown:groupSync:${groupId}`. After a demo save, `scheduleCatchUp(groupId)`:
  every 1.2 s one PC of the group that is not refused/failed/rolled back gets `configVersion = newest` (and `updatedAt = now`),
  then `touch()` (`store.ts`), so the demo shows 0 → m counting up. Timers are cleared by `resetDemo()`.
  The demo fixture "Pharmacy counter" (rings on, pilot 8; COUNTER-01 applied 8, COUNTER-02 partial 8, COUNTER-03 failed 8)
  already shows "2 of N, 1 could not apply, rings on"; "Warehouse … Night Shift" shows the "not sent yet" state.

## 7. Room for the admin-accounts warning

The other agent makes the PC skip only `hideAdminTiles` when E-71 is not recorded and report a warning (today's code for it:
`admin_signin_unverified`, already in `codes.ts` as a layer detail and a refusal). This page:
1. **"Your PCs" card** (group level): `adminTilesPending > 0` → warning line `adminTilesPending(n)` = "Admin accounts stay
   visible on 2 PCs until Other user sign-in is confirmed there." (use the other agent's sentence verbatim if it lands first;
   keep one string). Counted in `groupSync` from reports with `layers.machine.detail === "admin_signin_unverified"` or
   `refusal === "admin_signin_unverified"` (constant `ADMIN_TILES_CODES` in `convex/lockdown.ts`; adjust to the agent's final code).
2. **Advanced → Sign-in screen and PC**, under the "Hide administrator accounts" switch: the same line inline (warning tone)
   while the switch is on and `adminTilesPending > 0`.
3. Device page: owned by the other agent / `device-detail.md` (the Lockdown card already shows layer notes).
`hideAdminTiles` is never set by a preset, so the default change by the other agent does not turn a group into "Custom".

## 8. Strings (complete; `screens/lockdown/strings.ts` unless noted)

Mode words everywhere (UI only; data stays `off | audit | enforce`): **Off**, **Trial run** ("only report"), **Block**.
Check names: appLocker = **Employee program list**, appControl = **Windows safety list**, procWatch = **Rulebox program check**.

`lockdownStrings`:
- title "Lockdown"; titleFor(g) "Lockdown · {g}"; lead "What employees can and cannot do on this group's PCs."; back "Back to
  the group"; loadingTitle "Loading"; readOnly "Only administrators can change these settings."
- **Your PCs**: syncTitle "Your PCs"; upToDate(n, m, more) "PCs up to date: {n} of {m}{+}"; allUpToDate(m) "All {m} PCs are up
  to date." / one: "This PC is up to date."; sending(n, m) "Sending: {n} of {m} PCs have it"; waiting(k) "{k} waiting";
  waitingInfo "A PC gets the change the next time it is online. Rulebox never restarts a PC on its own."; problems(k) "{k}
  could not apply it:"; problemsInfo "Open the PC to see why. Nothing was changed on it."; noPcs "No PCs in this group yet.";
  noPcsAction "Add a PC"; notSent "Not sent yet. Your PCs get these settings when you save."; ringsOn "Rollout rings are on:
  pilot PCs get changes first."; ringsHalted "The rollout is paused. Other PCs wait until you resume it."; ringsAction "Open
  rollout"; reduced(k) "{k} PCs run Windows Home: the employee program list does not work there. The Rulebox program check
  still does."; adminTilesPending(k) (section 7).
- **Protection level**: levelTitle "Protection level"; levelInfo "Sets many Windows restrictions at once. Fine-tune them in
  Advanced settings."; presets.basic = { name "Basic", lead "Hides the risky Windows tools. Everything else stays open.",
  points ["USB drives allowed", "Settings app available", "Accessibility tools allowed"] }; presets.standard = { name
  "Standard", badge "Recommended", lead "The usual kiosk lockdown. Good for most shops.", points ["Windows tools hidden", "USB
  drives allowed", "Accounts lock after 10 wrong passwords"] }; presets.strict = { name "Strict", lead "For public or shared
  PCs. Also blocks USB drives and phones.", points ["USB drives and phones blocked", "Accounts lock after 5 wrong passwords",
  "Also applies to devices already plugged in"] }; custom(name, k) "Custom: {name} with {k} change(s)"; customReset(name)
  "Reset to {name}"; customShow "Show changes"; changed "Changed".
- **Program blocking**: modeTitle "Program blocking"; modeInfo "Decides which programs may start for employees. Start with a
  trial run, review the programs it finds, then block."; modes {off "Off", audit "Trial run", enforce "Block"}; modeSub
  {off "Nothing is checked.", audit "Only report", enforce "Not allowed = does not start"}; modeHelp {off "Programs are not
  checked or reported.", audit "Nothing is blocked. Programs that would be blocked are listed for you to review.", enforce
  "Only Windows, Rulebox, the apps you assigned and the programs you allowed can start."}; mixed "Mixed: set per check in
  Advanced settings."; trialDays(d) "Trial run for {d} day(s)."; trialLong(d) "Trial run for {d} days. Review the programs, then
  switch to Block." (≥ 7 days, warning tone).
- **Programs to review card**: reviewTitle "Programs to review"; reviewCount(n, more) "{n}{+}"; reviewLead "Allow what
  employees need before you block."; reviewNone "Nothing to review."; reviewOpen "Review programs" (link
  `/lockdown/findings?group={id}`).
- **Advanced**: advanced "Advanced settings"; tags {staff "Employees only", everyone "Everyone, incl. administrators"};
  section titles: checksTitle "Program checks", staffTitle "Windows tools for employees", machineTitle "Sign-in screen and PC",
  lockoutTitle "Wrong passwords", usbTitle "USB devices", inputTitle "Keyboard and accessibility", bootTitle "Start-up and
  recovery", perfTitle "Speed", netTitle "Wi-Fi".
  - checks: appLocker "Employee program list" / info "Employees can start only Windows, Rulebox and the programs you assigned or
    allowed. Administrators are not affected. Uses Windows AppLocker (not on Windows Home)."; appControl "Windows safety list" /
    info "Blocks programs that are known to get around security rules, for everyone on the PC, including administrators. Uses
    Windows App Control."; appControlLevel "Safety list strength"; levels {recommendedBlocks "Recommended list", allowlist
    "Strict list"}; levelHelp {recommendedBlocks "Blocks the programs Microsoft recommends blocking.", allowlist "Only Windows
    and installed programs may run, also for administrators. Try it on one PC first."}; procWatch "Rulebox program check" /
    info "Rulebox closes any program an employee starts that is not allowed. Works on every Windows edition. Administrators are
    not affected."
  - staff (label / info): taskManager "Hide Task Manager" / "Also removes it from the Ctrl+Alt+Del screen."; run "Hide the Run
    box" / —; commandPrompt "Block the command prompt" / "Batch files are refused too."; registryTools "Block the registry
    editor" / —; settings "Hide Settings and Control Panel" / —; signOut "Remove Sign out from Ctrl+Alt+Del" / "Employees sign
    out in the Staff App."; changePassword "Remove Change password from Ctrl+Alt+Del" / —; hideDrives "Hide drives in Open and
    Save windows" / "This only hides them. Program blocking decides what can run."; accessibilityHotkeys "Turn off
    accessibility shortcut keys" / "For example pressing Shift five times."; officeMacros "Turn off Office macros" / "Macros in
    Word, Excel and PowerPoint do not run."
  - machine: hideSwitchUser "Hide Switch user"; hideSignInPower "Hide the power button on the sign-in screen"; hideAdminTiles
    "Hide administrator accounts" / "Administrators sign in with Other user. Used only on PCs where that is confirmed to work.";
    noWakePassword "No password after sleep"; denyElevationRequests "Never ask employees for an admin password" / "A program that
    needs administrator rights does not start for an employee."; restrictPrinterDrivers "Only administrators install printer
    drivers"; fileOutputPrinters "Hide Print to PDF and other print-to-file printers" / "So employees cannot save documents that
    way."
  - lockout: lockout "Lock an account after wrong passwords" / info "Off leaves the PC's own setting as it is. Applies to every
    account on the PC."; lockoutThreshold "Wrong passwords allowed" / info "A whole number from 5 to {MAX}."; lockoutDuration
    "Lock for (minutes)"; lockoutWindow "Count within (minutes)" / info "Wrong passwords are counted for this long. Not longer
    than the lock."; lockoutProblems unchanged.
  - usb: usbAlways "Keyboards, mice and touch screens always work."; usb {storage "USB drives and memory cards", printers "USB
    printers", imaging "Scanners and cameras", phones "Phones", other "Other USB devices"}; usbInfo {storage "Also covers card
    readers inside printers. Employees have no other way to hand in files yet. Employees only.", printers "Network printers keep
    working. Everyone, incl. administrators.", imaging "Everyone, incl. administrators.", phones "Employees only.", other "A fixed
    list of device kinds, for example serial ports and modems. Everyone, incl. administrators."}; storageModes {allow
    "Allowed", readOnly "Read only (open, not save)", block "Blocked"}; usbModes {allow "Allowed", block "Blocked"};
    usbOtherWarning unchanged; usbRetroactive "Also apply to devices already plugged in" / info "Without this, a block only
    affects devices plugged in later."
  - input: winCombos "Block Windows-key shortcuts" / "For example Windows+R and Windows+E. The admin exit keeps working.";
    accessibilityTools "Allow Narrator, Magnifier and the on-screen keyboard" / "The Staff App's own accessibility features are
    always on."
  - boot: autoRecovery "Hide the Windows recovery screen" / "Stops the PC from opening recovery after failed starts. Left on by
    itself on PCs that BitLocker protects."; safeModeGuard "Keep employees out of Safe Mode" / "Rulebox also runs in Safe Mode
    and does not sign the employee account in there."
  - speed: staffTuning "Make Windows lighter for employees" / "Turns off animations, background apps and start-up programs.";
    kioskProfile "Turn off unneeded Windows services" / "Everyone, incl. administrators."; noPrinting "This group does not
    print" / "Stops the print service to save memory. It stays on whenever this group has printers."
  - wifi: wifiManagedOnly "Only this group's Wi-Fi networks" / "PCs can join only the Wi-Fi networks you added for this group.
    Needs at least one."; wifiManagedOnlyConfirm "Apply even if a PC goes offline" / "A PC on another network goes offline until
    it sees one of this group's networks."
- **Extra allowed programs**: exceptionsTitle "Extra allowed programs"; exceptionsInfo "Programs you allowed from the review
  list. The apps you assigned to this group are always allowed."; exceptionsNone "None yet."; exceptionsTruncated "Showing the
  newest 50."; exceptionKinds {publisher "By publisher", hash "This exact version", path "By folder"}; exceptionWhat: publisher
  "{file} from {signer}", hash "{file or 'A program'} (this exact version)", path "{last folder}\{file}"; breaksOnUpdate "Allow
  again after updates"; breaksOnUpdateHelp "This matches one exact version. After an update the program is blocked until you
  allow it again."; forApp unchanged; removeException "Remove"; removeExceptionTitle "Remove {file}?"; removeExceptionBody "It
  is blocked again once the group blocks programs. It goes back to the review list."; exceptionRemoved "Removed."
- **Save**: save "Save"; discard "Undo changes"; unsaved(k) "{k} unsaved change(s)"; changesInfoMore(k) "and {k} more"; saved
  "Saved. Your PCs get this within a minute."; savedRings "Saved. Pilot PCs get this within a minute; the others when the rollout
  moves on."; enforceTitle "Start blocking programs?"; enforceIntro "From now on, programs that are not allowed do not start on
  this group's PCs."; enforceFindings(n, more) "{n}{+} programs are still waiting for review. They will be blocked." / 0: "Nothing
  is waiting for review."; enforceAppControl "The Windows safety list also applies to administrators."; enforceAuditFirst "A PC
  that never had a trial run does one for 24 hours first."; enforceReview "Review programs first"; managedConfirm "Only this
  group's Wi-Fi: a PC on another network keeps it and reports a problem. A PC with none of these networks in range goes offline,
  and then Rulebox cannot reach it."; enforceConfirm "Save and apply"; managedEmpty "Add a Wi-Fi network to this group first.";
  badLockout unchanged.

`findingsStrings`: title "Programs to review"; lead "Programs your PCs stopped, or would stop in a trial run. Allow what
employees need."; statuses {new "To review", allowed "Allowed", ignored "Ignored"}; colProgram "Program", colWhere "Found in",
colDevices "PCs", colSeen "Last seen", colActions "Actions" (colSigner, colLayer removed); unsigned "Unknown publisher" + info
"The program is not signed, so it can only be allowed as this exact version."; folders {windows "Windows folder", programFiles
"Program Files", rulebox "Rulebox folder", userProfile "Employee's own folders", userTemp "Temporary files", removable "USB
drive", network "Network folder", other "Another folder"}; layers {appLocker "Employee program list", appControl "Windows safety
list", procWatch "Rulebox program check"}; pcs(n); allow "Allow"; ignore "Ignore"; ignoreTitle(f) "Ignore {f}?"; ignoreBody "It
leaves the review list. Nothing is allowed. You can still allow it from Ignored."; ignored "Ignored."; emptyTitle {new "Nothing
to review", allowed "Nothing allowed yet", ignored "Nothing ignored"}; emptyBody {new "When a PC stops a program, or would in a
trial run, it shows up here.", …unchanged}; appControlNote "Can't be allowed" + appControlInfo "Windows blocks this one for
everyone because it can get around security rules. It cannot be allowed one by one."; howTitle "How to review"; howSteps ["Allow
what your employees need.", "Ignore the rest.", "Switch the group to Block."]; backToGroup(g) "Back to {g}".
Allow dialog: allowTitle(f) "Allow {f}"; allowLead "Employees in the chosen groups can start this program."; recognisedBy
{publisher(s) "Recognised by its publisher, {s}. Keeps working after updates.", hash "Recognised as this exact version. After an
update, allow it again.", path "Recognised by its folder."}; ruleKind "How to recognise it"; kinds {publisher "By publisher
(recommended)", hash "This exact version", path "By folder"}; kindUnavailable {publisher "Not signed", hash "The PC did not send
its fingerprint", path "Not in a protected folder"} (as `SelectOption.hint` of the disabled option); folder "Folder"; folderHint
unchanged; groups "Allow in"; groupsFilter "Find a group"; groupsHint `Up to ${MAX_ALLOW_GROUPS} groups.`; app "Belongs to app";
reason "Note"; allowConfirm "Allow"; allowing "Allowing…"; allowed(k) unchanged; errors / tooMany* unchanged in meaning.

`deviceStrings.ts` (words only): layers {staff "Windows tools for employees", machine "Sign-in screen and PC", appLocker
"Employee program list", appControl "Windows safety list", procWatch "Rulebox program check", boot "Start-up protection",
performance "Speed"}; configVersion "Settings version"; lkg "Last working settings"; reducedHomeDetail "Windows Home has no
employee program list. The Rulebox program check still works."; tooOld "Rulebox on this PC is too old for lockdown".
`codes.ts`: `LAYER_MODE_LABELS` {off "Off", audit "Trial run", enforce "Block", on "On"}; `LAYER_STATES.auditFirst` "Trial run
first"; reword jargon details: audit_first "This PC has not had a trial run yet, so it reports only for 24 hours before it
blocks."; lkg_failed "… Program blocking is in trial run until the next restart."; applocker_not_on_this_edition "This Windows
edition has no employee program list (AppLocker)."; applocker_foreign_policy "This PC already has program rules that Rulebox did
not make. Rulebox left them alone."; app_id_service_missing/unreadable "The Windows service the employee program list needs is
missing / could not be checked."; os_too_old_for_app_control "This Windows version is too old for the Windows safety list.";
appcontrol_not_built / policy_not_embedded "This Rulebox build has no Windows safety list."; allowlist_level_with_user_install
(both maps) "The strict safety list cannot be used while an assigned app is installed for one user only."; snapshot_fallback
"The Rulebox program check uses a slower method on this PC. Programs are still blocked."; blocked_by_guard "The Rulebox program
check is switched off on this test PC."; watch_thread_failed "The Rulebox program check stopped. It restarts with Rulebox."
`overview/strings.ts`: auditTitle "Trial run for more than 14 days: {names}"; auditDetail "Nothing is blocked yet. Review the
programs, then switch to Block."; notAppliedTitle "Lockdown not applied on: {names}".

## 9. Edge cases and roles

- **Roles**: viewer sees everything read-only (radio cards and controls disabled, no save bar, no Remove, Allow/Ignore hidden,
  "Your PCs" visible); admin and owner change. Server enforces as today (`memberMutation("admin")`).
- **Never saved** (`revision` 0): shows the org defaults; usually "Standard". First save inserts the row as today.
- **Mixed modes** / **Strict list** level / any hand-made combination → "Custom" with nearest preset; never rewritten silently.
- **Applying a preset** keeps modes, `hideAdminTiles`, speed and Wi-Fi fields; the lockout draft is rebuilt from the preset.
- **Lockout invalid inside closed Advanced**: Advanced opens, focus goes to the first error (section 4).
- **Stale edit** (someone else saved): Reload brings the saved values, as today.
- **Empty group** (m = 0): "No PCs in this group yet." + "Add a PC" (`/enrollment`); save still works.
- **No configuration version yet** (no rollout row, e.g. demo "Warehouse … Night Shift"): "Not sent yet…".
- **More than 200 PCs**: "PCs up to date: 150 of 200+"; stale reports of moved PCs can use part of the 201-report window
  (they are filtered, so n can only be under-counted, never over).
- **Revoked PCs** are counted in m (revocation lives in `deviceCredentials`; reading it would add a read per PC). They sit in
  "waiting". Same as `groups:get` counts today. Follow-up if the owner minds.
- **Old agents** (no `config` in the report) never enter the range → "waiting"; the device page already says "too old".
- **Rings on / paused**: up to date = the newest version, so non-pilot PCs wait for promotion; the card says so and links to
  the rollout page. Paused: `ringsHalted`.
- **Home edition**: `reduced` line; presets unchanged.
- **Dashboard offline**: Convex queues the mutation; the button stays "Saving…" until it lands; the shell's connection banner
  explains. "Your PCs" keeps its last value.
- **Findings**: Windows safety list rows show only Ignore (+ info); Allowed rows have no action; Ignored rows show Allow only.
  `?group=` preselects that group in the Allow dialog; an org with one group preselects it and hides the picker ("Allowed in
  Pharmacy counter"). Folder kind prefills `{ProgramFiles}\` (folderClass programFiles) or `{RuleboxApps}\` (rulebox).
- **Admin accounts** warning: section 7.

## 10. Tests

Change:
- `src/screens/step19.test.tsx` "the group lockdown screen": queries become `{lockdown:groupView, lockdown:groupSync}` (add a
  `groupSync` fixture in `beforeEach`); card titles → new sections (Advanced opened in tests via its summary); native-select
  `.value` assertions → the custom `Select` (button + listbox) helpers the foundations agent adds; save → toast `s.saved`;
  confirm dialog strings; viewer test counts radios too. "the findings screen": `fs.allow` = "Allow"; no Signed by / Rule columns;
  the Allow dialog kind is under Advanced and auto-picked; `?group=` preselect. "the device page cards": literal "Auditing
  first" → "Trial run first", "Agent too old for lockdown" → `ds.tooOld`. "the overview warnings": the literal audit title.
- `src/data/demo/lockdown.test.tsx`: add `useLockdownSync` (Pharmacy counter 2 of N, 1 problem, rings on; Night Shift
  `newestVersion: null`), and "a save makes the counter go up" with fake timers.
- `convex/lockdown.test.ts`: `groupSync` counts (applied/partial up to date, refused/failed/rolledBack problems, ≤ 3 names),
  rings on (non-pilot waits), moved-away PC ignored, no rollout row, cap (`totalMore`), Home `reduced`, `adminTilesPending`,
  viewer allowed, foreign group `not_found`, read count within the budget.
- `tests/convex/matrixRows.ts`: row `lockdown:groupSync` (`VIEWER`, foreign `not_found`). Whatever test pins that every
  function has an `ioBudgets` row picks up the new entry.
New:
- `src/screens/lockdown/presets.test.ts`: Standard equals `DEFAULT_LOCKDOWN_SETTINGS` on every preset field; each preset
  round-trips through `presetOf`; non-preset fields (modes, `hideAdminTiles`, speed, Wi-Fi) never change the result; Custom
  nearest + changes (ties → standard); `applyPreset` keeps non-preset fields; Strict lockout passes `lockoutProblems`;
  `programModeOf` / `setProgramMode` incl. mixed; `changeLabels` lists labels and caps at 8.
- `src/screens/lockdown/strings.test.ts`: no visible string contains "AppLocker", "App Control", "Process watch", "Audit",
  "Enforce" outside the (i) texts that name the Windows feature on purpose; every (i) ≤ 3 sentences.

## 11. Build steps (one Sonnet agent each)

Wait for the foundations components (`InfoTip`, `Field info`, `Select`, `SearchSelect`, `PageTabs`/`useUrlTab`, `dash-split`,
`dash-advanced`) before steps 5–7; code against the README names.

1. **Server** (parallel A): `convex/lib/limits.ts` (`LOCKDOWN_SYNC_CAP`), `convex/lockdown.ts` (`groupSync`,
   `ADMIN_TILES_CODES`), `convex/ioBudgets.ts`, `tests/convex/matrixRows.ts`, `convex/lockdown.test.ts`. Verify with
   `pnpm test:convex` + typecheck. Never `convex dev/deploy`.
2. **Pure rules** (parallel A): `screens/lockdown/presets.ts` (new), `rules.ts` (`programModeOf`, `setProgramMode`,
   `changeLabels`), `presets.test.ts`.
3. **Strings** (parallel A): `strings.ts`, `deviceStrings.ts`, `codes.ts`, `overview/strings.ts`, `strings.test.ts`, and the
   literal-string fixes in `step19.test.tsx` device/overview blocks only.
4. **Data seam** (after 1): `data/types.ts`, `data/lockdown/api.ts`, `index.ts`, `live.ts`, `data/demo/lockdown.ts` (sync +
   catch-up timers, cleared in `resetDemo`), `data/demo/lockdown.test.tsx`.
5. **Lockdown pieces** (after 2, 3, 4; two agents in parallel, separate files):
   5a `lockdown/RadioCards.tsx`, `lockdown/PresetPicker.tsx`, `lockdown/ProgramMode.tsx`, `lockdown/AdvancedSettings.tsx`
   (presentational, props in / onChange out, Changed pills, admin-accounts inline slot).
   5b `lockdown/SyncCard.tsx` (uses `useLockdownSync`), `lockdown/AllowedPrograms.tsx` (old Exceptions, reworded),
   `lockdown/ReviewCard.tsx`.
6. **Lockdown composition** (after 5): `Lockdown.tsx` (form state as today + presets, sticky `SaveBar`, toast by `ringsOn`,
   open-Advanced-on-error), `lockdown/lockdown.css` (bands, multi-column, sticky bar, progress bar), `step19.test.tsx` lockdown
   block.
7. **Findings** (after 3; parallel with 5–6): `Findings.tsx` (PageTabs, columns, aside, `?group=`), `lockdown/AllowDialog.tsx`
   (auto kind, Advanced, preselect, group filter, `SearchSelect` for the app), `step19.test.tsx` findings block.
8. **Verify** (last): typecheck + lint + `pnpm --filter @rulebox/dashboard test`, `node scripts/size.mjs` (report any needed
   raise for the Lockdown/Findings chunks with the measured numbers; never raise silently), screenshots on port 4344:
   `--paths=lockdown:@group/lockdown,findings:/lockdown/findings` at 390/820/1366/1920, light + dark; check Custom, mixed,
   viewer, saving count-up in demo. Update `docs/plans/ui-pass/README.md` index status if the lead agent asks.

## 12. Decisions taken (recommended option taken; owner reviews)

- **D1 Number of levels**: 2 / **3 (Basic, Standard, Strict) + derived Custom** / 4. Three is the smallest set with a clear
  "lighter" and "stricter" choice around today's defaults.
- **D2 Presets and program blocking**: presets also set modes / **modes are their own control (Off · Trial run · Block)**.
  Trial run → Block is a step in time, not a strength; mixing them would turn a group "Custom" the day it starts blocking.
- **D3 Fields outside presets**: **`hideAdminTiles`, Speed, Wi-Fi, modes** stay out. PC-dependent or able to cut PCs off.
- **D4 Strict list (App Control allowlist)**: in Strict preset / **Advanced only**. It breaks PCs with per-user apps; never one click.
- **D5 Store the preset**: new field / **derived on the client**. No schema change, field names untouched, no drift.
- **D6 Custom display**: plain "Custom" / **"Custom: Standard with 2 changes" + Reset + "Changed" pills in Advanced**.
- **D7 Mode words**: Audit/Enforce / **Off · Trial run (only report) · Block**; data values unchanged.
- **D8 Saving**: autosave per switch / **explicit Save in a sticky bar**. Confirm dialogs, PIN and lockout validation need one
  moment of commit; the bar makes the one main action obvious.
- **D9 n of m data**: counter row per group maintained in `deviceApi:reportApply` (hot row under OCC when many PCs report at
  once, drifts on moves/revokes) / slim per-device `deviceConfigApplied` table (new schema + device write path + backfill) /
  **new query over the existing `devices.by_group` + `deviceApplyReports.by_org_config`, capped at 200**. Zero new writes,
  same pattern as `rollouts:health`; fallback = the slim table if the I/O probe shows the query is heavy for large groups.
- **D10 "Up to date"**: applied only / **applied or partial, at the newest version**. Partial still got the settings.
- **D11 Query split**: inside `groupView` / **separate `lockdown:groupSync`**, so report traffic never re-runs the form query.
  Deviation from "one query per screen" (same as the rollout screen); tell the owner (PRD 4.20 lists one query).
- **D12 Where n of m shows**: also on the group page / **lockdown page only** for now (no extra subscription elsewhere).
- **D13 Findings list**: custom review queue with date groups / **`ServerTable` with plain columns** (gets the shared Cards view;
  "grouped" = one row per program + To review / Allowed / Ignored tabs). No client-side regrouping across pages.
- **D14 Findings name**: keep "Findings" / **"Programs to review"** (route unchanged).
- **D15 Allow dialog**: ask the rule kind / **pick the best kind automatically, choice under Advanced; preselect the group from
  `?group=` or the only group; app and note under Advanced**.
- **D16 Folder template**: empty input / **prefilled root by folder class**.
- **D17 Advanced layout**: grid / **CSS multi-column of section cards**, closed by default, opens on error.
- **D18 Check names**: keep Windows names / **plain names, Windows name only inside (i)**.
- **D19 Device page and overview words**: leave / **same words via string files only** (layout stays with `device-detail.md`).
- **D20 Strict values**: lockout 5/30/30, USB drives + phones blocked, retroactive on. **D21 Basic values**: Settings, Sign out,
  Change password, drives, Switch user, power button, print-to-PDF open; accessibility tools allowed; lockout left to the PC;
  recovery screen left.
- **D22 Revoked PCs in m**: read credentials per PC / **count them (as `groups:get`)**; documented limitation.
- **D23 Extra allowed programs**: main column / **aside on laptop+**, renamed.
- **D24 Account lockout numbers**: automate away / **keep as inputs in Advanced; presets fill them**.

PRD / plan changes to report to the owner: PRD 4.20 "layer cards with mode switches" becomes protection level + program
blocking + Advanced; the lockdown screen subscribes to two queries; UI words Trial run / Block replace Audit / Enforce (data
unchanged).
