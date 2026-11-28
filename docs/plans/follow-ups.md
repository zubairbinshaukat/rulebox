# Follow-ups (found outside a phase plan)

Small issues found while doing other work. Each gets moved into the plan of the phase that fixes it.

## NEXT after VM run A3: dashboard UI pass (owner, 2026-11-28)

Start this right after the VM run A3 agent is done and its commits are reviewed. Screenshots (gitignored,
they show a real Wi-Fi name): `.personal/ui-pass-2026-11-28/01..07-*.png`. Rules that still apply: custom UI,
no component library (`packages/ui/`), Solar icons only, everything bundled (no CDN), dashboard animation in
plain CSS (opacity/transform, reduced motion and Lite honoured), 4 GB target. Fix things in the **shared**
components so every screen gets the fix, not screen by screen. Look at every changed screen at phone,
tablet, laptop and wide desktop widths (screenshots) before calling it done.

### 0. TOP PRIORITY: the device detail page
- The owner's most important layout fix. The page must show a PC's information **easily and precisely**:
  what state it is in, what is wrong, and what to do, at a glance.
- Use **tabs** (or a similar split) to separate the groups of information instead of one long page, for
  example Overview, Apps and installs, Lockdown and protection, Network and printers, Activity / audit,
  Settings. Decide the final split from the fields the page actually has (list them all first, as for the
  cards in section 2), and keep the tab in the URL so a reload or a shared link opens the same tab.
- Overview: a header with the PC's name, online state, kiosk state, version and the few numbers that
  matter, then the problems that need attention. Details go one click deeper, not on the first screen.
- Plan it first (Opus agent, like section 2), review the plan, then build. It must respect the data rules:
  still **one query per screen/tab**, bounded, nothing loaded for tabs that are not open.

### 0b. TOP PRIORITY too: the whole Settings page
- Redesign Settings with the same care as the device page (plan with Opus, review, then build): clear
  sections or tabs, the few things people change often up front, rare and risky options further in.
- **Settings > Updates:** instead of typing version, URL, SHA-256 and size in bytes, show the Rulebox
  releases from GitHub (Convex action, public releases API, cached; no database reads) and let the owner
  pick one; picking fills version, MSI URL, `sizeBytes` (GitHub's asset size) and SHA-256 (the release's
  `SHA256SUMS`). Owner-only + PIN confirmation stays; manual entry stays under "Advanced" for custom builds.
  Show the release notes and whether it is a pre-release. Empty state until the first `v*` release
  (dry runs are artifacts, not releases). Note for the plan: until SignPath signing, the hash comes from the
  same place as the file (same-source trust); say so in the plan, not in the UI.

### 0c. TOP PRIORITY too: Add app page redesign + popular apps gallery
- Redesign the Add app flow (Opus plan, review, build) under the non-technical rule below.
- **Popular apps gallery:** a grid of well-known apps (Chrome, Edge, Firefox, Zoom, Teams, VLC, 7-Zip,
  Adobe Reader, Notepad++, LibreOffice, ...) with their icons; one click adds the app with its winget ID
  (`convex/lib/winget.ts`) and good defaults, then the usual review/assign step. Search for anything else.
- winget manifests usually have **no icon**, so keep a small curated list in the repo (ID, display name,
  icon, category) with the icons **bundled** (offline-first; no runtime icon API). App logos are app art,
  not UI icons, so the Solar-only rule does not apply to them; check each logo's trademark/usage terms and
  fall back to a letter tile when unsure.

### 0d. TOP PRIORITY too: Lockdown page made easy
- Many settings are hidden under Lockdown and the words are technical (AppLocker, App Control, Process
  watch, Audit / Enforce, ...). Plan it like the device and Settings pages (Opus plan, review, build):
  plain everyday words, a few clear levels or presets first (for example "Standard protection"), the
  individual switches under "Advanced", the (i) tooltip for explanations.
- **Saving publishes by itself** (no Publish button: a save snapshots the group config and requests a
  publish). The owner looked for a Publish button after saving: say it on save, e.g. "Saved. Your PCs get
  this within a minute." and show per-group "PCs up to date: n of m".

### Bug: "Hide administrator accounts" is ON by default and blocks the whole lockdown (VM run A3, 2026-11-28)
**DONE locally 2026-11-28 (branch `t3/post-vm-run-a3-followups`, needs the VM re-test):** default `false` for new groups (existing groups keep their stored value), the agent skips only that option without E-71 and reports the layer note `admin_tiles_skipped` (machine layer, shown on the device's Lockdown card), `admin_signin_unverified` is no longer produced. Original problem text below.

- `DEFAULT_LOCKDOWN_SETTINGS.hideAdminTiles = true` (`convex/lib/lockdownValidators.ts:94`). A PC that never
  recorded E-71 (Other user sign-in works) refuses the **whole** lockdown section (`admin_signin_unverified`,
  guard I7), so a new group's PCs get no lockdown at all.
- **Owner decision 2026-11-28: (c) both.** (1) Default `hideAdminTiles: false` for new groups (existing
  groups unchanged). (2) Agent: when `hideAdminTiles` is on but E-71 is not recorded, skip only that one
  option, apply the rest, and report a warning the dashboard shows on the device and group ("Admin accounts
  stay visible on this PC until ... is confirmed"). Tests on both sides; check the PRD/plan text for I7 and
  update it (tell the owner what changed).

**Bar for the whole pass (owner):** "I want to be impressed by the layout management of each page." Every
page gets a deliberate layout for desktop, tablet and phone; nothing is just a stack of full-width
sections.

**Users are not technical (owner, applies to every page):** make things easy, not hard. Too much text or
too many options confuses them. For each page: show only what most people need, in plain words; hide
technical values (hashes, byte sizes, IDs, registry-ish names) or fill them automatically; put advanced and
rarely used options behind "Advanced" or a later step; prefer a good default over a choice; one clear main
action per screen; short labels with the (i) tooltip (section 4) for the explanation. The planning agents
must review every field against this rule and say which ones they hide, move or remove.

**Automate the complex things (owner, 2026-11-28, same priority as the rule above):** "we must automate complex
things so that a normal user can easily get used to our dashboard." Never ask a normal user for technical input
up front.
- **Add Windows app:** no silent-install command/arguments input by default. Pick a sensible silent mode
  automatically (by installer type, or from winget data) and show a short line such as "Installs silently" with
  an (i) tooltip. The command field goes under "Advanced".
- **Add website / web app:** replace the raw "allow subdomains" input with an interactive example: the site's
  address with parts the user can click or toggle ("also allow mail.example.com, shop.example.com") and a live
  preview of which addresses open and which are blocked. Same data model; only the way it is entered changes.
- **Add a PC (enrollment):** a few simple, guided steps (1. Create code, 2. Run the installer on the PC, 3. Done,
  the PC appears here). No list of prerequisites up front. Download, copy and QR are one click, technical details
  go behind (i) or "Advanced", and the page shows live progress when the new PC appears.
- **Every form:** list every input a normal user would not understand and say how it is automated, defaulted,
  hidden or turned into an interactive picker (`docs/plans/ui-pass/audit.md`).

### 1. Generic table (one fix, every table) — `01`, `02`
- Short values wrap mid-phrase: "0 of 1 used", "4 minutes ago", "in 56 minutes" break over two lines while
  wider columns have room. Short cells (counts, dates, states, badges) stay on one line; columns size to
  content with sensible min/max widths; only long free text (names, labels) wraps or truncates with the
  full text on hover/focus.
- At medium widths the table scrolls sideways and the footer breaks apart: "Page 1" centred above the pager,
  "Rows per page" on the left with its select far right. The footer needs one layout per width band
  (one row on desktop; a tidy, aligned stack on narrow screens).
- Check every table in the dashboard after the change (Enrollment, Devices, Employees, Apps, Audit, ...).

### 2. Cards view (Table | Cards switch) — `03` — **plan it with an Opus agent** (owner's explicit choice)
- Today a card is a full-width list of label/value rows with the value pushed to the far right: hard to
  scan, lots of empty space, one card per row even on a wide desktop.
- The Opus agent first lists every field of every card-capable list and sorts them into roles: title,
  status/badge, key facts, secondary details, actions. Then it plans: how each role is shown, how much text
  each field may show before it truncates or wraps (with full text on hover/focus), when to show one card
  per row vs a grid (2/3/4 columns by container width), where actions go, and edge cases (very long names,
  missing/empty values, many fields, many badges, one record, hundreds of records, keyboard focus, screen
  readers). Use best practice for card-based lists. The plan is reviewed before building.

### 3. Custom global dropdowns (replace every native `<select>`) — `04`
- The sort select opens the browser's native, unstyled list (wrong colours in dark mode).
- Build three shared components in `packages/ui/`: **Select** (simple), **Searchable select** (type to
  filter, for long lists such as groups or apps), and both must **open down or up automatically** depending
  on the space in the viewport (and stay inside it on phones).
- Very long option text: truncate in the trigger with the full text on hover/focus; in the menu wrap or
  truncate consistently, never widen the page. Full keyboard support (arrows, Home/End, type-ahead, Esc,
  Enter), ARIA listbox/combobox roles, focus returns to the trigger, works with forms and validation.
- Replace all native selects: sort, rows per page, Settings (Program rules, Security, ...), forms.

### 4. Helper text → info icon + tooltip (every page) — `06`, `07`
- Forms carry long helper paragraphs under almost every field (Program rules, New Wi-Fi network). Keep only
  what the user needs to act; move the rest into an **(i) icon next to the label** that shows a tooltip on
  hover and focus. Errors and warnings stay visible inline, never only in a tooltip.
- Define the tooltip once in `packages/ui/`: maximum width and length of content, placement that flips to
  stay on screen, delay, keyboard access, and **mobile behaviour** (tap the icon to open a popover; tap
  outside to close; no hover).
- Apply the pattern on every page, not just Networks.

### 5. Networks page layout — `05`, `06`
- Wi-Fi, Printers and Drivers are stacked full-width sections; on desktop use a grid of the three sections,
  each with proper cards for its records (and compact empty states instead of the big centred one).
- **New Wi-Fi network:** the owner could not find where to set the password ("The password is set
  separately, in the Password card" is easy to miss). Put the password in the add form (it stays encrypted
  as today), or make the next step impossible to miss. Trim the helper text per section 4.

### 6. Desktop layouts on every page
- Every page on desktop is one long column of full-width sections. Use the width: multi-column grids of
  sections, two-column forms where fields are short, side-by-side summary + detail. Define page-layout
  rules (breakpoints, max content width, column counts) once and apply them to every screen.

## VM run A3 owner answers (2026-11-28)

Questions from `docs/plans/phase-6-vm-results.md` "Run A3". All answered with the recommendation.

- **Q-A4 (hideAdminTiles default):** answered as (c) both, see the bug section above.
- **Q-A5 (deleted employee's browser profile) — DONE locally 2026-11-28, needs the VM** (`cleanup.rs` profile-only round at agent start and after every roster change, retried every 30 s while somebody is signed in): after a roster change removes an employee, the agent runs a
  profile-only cleanup for that employee's browser profile the next time nobody is signed in (not only at
  the next employee sign-out). Tests: removal while signed out, while another employee is signed in, across
  a restart.
- **Q-A6 (ProgramData after uninstall) — DONE locally 2026-11-28, needs the VM:** `PurgeDataAtUninstall` (new MSI action running `rulebox-agent purge-data` after StopServices, same condition as the unenroll); the uninstall-only step deletes everything in
  `C:\ProgramData\Rulebox` except `logs\` (so `state\` incl. `secrets.bin`, and `downloads\`). Must not run on
  major upgrade (same rule as UnenrollAtUninstall).
- **Q-A7 (empty policy keys) — DONE locally 2026-11-28, needs the VM** (`journal.rs` `record_created_keys` / `prune_created_keys`, `machinereg::check_created_key`; state field `createdMachineKeys`; PCs set up before this change have no record and keep their empty keys): low priority, after the main fixes: on uninstall/restore remove the policy keys
  Rulebox itself created (OOBE, PowerSettings\0e796bdb…, PointAndPrint), only when they are empty.
- **Q-A8 (stuck restore) — DONE locally 2026-11-28, needs the VM** (`recover --forget <id> [--yes]`, `recover.rs::forget_interactive`; a `recover` that fails to restore an entry now prints the ids to use; log in `logs\recover-forget.log`): add `recover --forget <id>`: admin only, asks for confirmation, refuses unless the
  entry's live value already equals the recorded original, writes an audit/log line.

## Dashboard onboarding: PIN setup (Phase 4b) edge cases — found 2026-11-28

Seen on the dev deployment `gallant-ocelot-38` while preparing VM run A3.

**Status 2026-11-28: items 1-5 done** (branch `t3/pin-setup-edge-cases`; not pushed). Setup is "unfinished" on the
server as `account:me.pin.codesPending` (PIN set, recovery codes never made, pepper set); `stepUp:status.pin.recoveryAvailable`
says up front whether codes can be made; `setActionPin` refuses a first PIN without the pepper; a dismissible
passkey banner (`stepup/PasskeyReminder.tsx`) links to Settings, Security.

1. **A missing server secret shows only "This isn't ready yet. Try again in a moment."** Step 2 (recovery
   codes) failed because `RULEBOX_RECOVERY_PEPPER` was not set (`convex/lib/recoveryCodes.ts`, `not_ready`).
   "Try again" can never help. Fix: map this `not_ready` detail to its own message (like
   `notReadySigningKey`): what is missing, who can fix it (the operator), and that the PIN is already saved.
2. **The PIN is saved before the server is known to be able to finish setup.** Step 1 succeeds, step 2 fails.
   Fix: check the deployment can make recovery codes (pepper present) before step 1, or say up front that
   recovery codes are unavailable on this deployment.
3. **Refresh or closing the tab after step 1 skips the rest of setup for good.** `SetupScreen` is shown only
   while `me.pin.required && !me.pin.set`; once the PIN is set a reload goes straight into the dashboard with
   no recovery codes and no passkey, and nothing tells the member. The "resumed" path in
   `apps/dashboard/src/stepup/SetupScreen.tsx` covers only an interruption by the lock screen. Fix: keep
   "setup unfinished" on the server (for example: PIN set and no recovery codes yet) and resume at step 2
   after a reload, or at least show a banner that links to Settings, Security (where codes can be made).
4. **Same for step 3 (passkey):** skipped silently on reload. A banner or the Security tab is enough, since
   it is optional.
5. Tests: reload after step 1 resumes at step 2; missing pepper shows the operator message before any PIN
   is set; the new strings in `strings.ts`.
