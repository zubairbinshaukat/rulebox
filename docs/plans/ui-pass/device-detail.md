# Device detail page (`/devices/:id`) — UI pass plan

Status: planned 2026-11-28 (Opus planning agent). Recommended options taken; the owner reviews afterwards.
Spec: `follow-ups.md` "0. TOP PRIORITY: the device detail page", the owner rules in `ui-pass/README.md`,
PRD 11.1 (data rules), 24.2 (Wi-Fi/printers), 24.3 (rings), 24.4 (lock). Shared components (PageTabs,
useUrlTab, Select, SearchSelect, InfoTip, Field `info`, `dash-*` layout classes) are named as in the README contract.

**Goal.** One look tells an admin: is this PC online, is kiosk working, is it up to date, what is wrong, and the one
thing to do about it. Everything else is one tab or one click deeper. Today the page is one long two-column stack
of ~15 cards (`.tmp/ui-pass/before/device-1366-dark.png`), raw codes in red banners (`desired_state_untrusted`,
`rulebox-agent trust-key`), and one query (`fleet:get`) that reads up to 500 groups and 5 version rows on every run.

---

## 1. Inventory (today)

Files: `screens/DeviceDetail.tsx` (DD), `screens/lockdown/DeviceCards.tsx` (LC), `screens/display/DeviceDisplayCard.tsx`
(DC), `screens/broadcasts/LockCard.tsx` (LK), `components/HistoryPanel.tsx` (HP), `components/DeviceCells.tsx` (CELL).
Data: `fleet:get` (G), `fleet:liveness` (L), `fleet:installs` (I), `audit:forTarget` (A), `fleet:watch` (W, mutation).

| # | Item | Source | Data |
|---|---|---|---|
| 1 | Back link "All devices" | DD PageHeader | — |
| 2 | Name (h1, wraps) | DD | G.name |
| 3 | Online / Offline since / never seen pill | CELL DeviceOnline | G.presence |
| 4 | Kiosk pill (Revoked / Kiosk off / phase) | CELL KioskCell | G.kioskEnabled, report.kioskPhase |
| 5 | "Out of support" pill | DD | summary.outOfSupport |
| 6 | Send a message to this PC (admin, not revoked) | DD + broadcasts/SendDialog | broadcasts:send |
| 7 | Rename (admin) → dialog | DD RenameDialog | fleet:rename |
| 8 | Banner: locked | DD | G.lock |
| 9 | Banner: revoked | DD | G.flags.revoked |
| 10 | Banner: no group | DD | G.flags.noGroup |
| 11 | Banner: out of support | DD | summary.outOfSupport |
| 12 | Banner: "The kiosk reported a problem: <code>" | DD | report.kioskError |
| 13 | Banner: restart pending | DD | report.restartPending |
| 14 | Banner: trusts no signing key + `rulebox-agent trust-key` | DD | report.trustedKeyIds = [] |
| 15 | Banner: credential rotation pending | DD | flags.rotateCredential |
| 16 | Status: last contact | DD LastContact | L.lastContactAt |
| 17 | Status: last report | DD | report.updatedAt |
| 18 | Status: agent version (mono) | DD | report.agentVersion |
| 19 | Status: Windows + build ("Windows 11 26100.4336") | DD | report.os, osBuild |
| 20 | Status: edition (raw "Core") | DD | report.osEdition |
| 21 | Status: memory, free disk | DD | report.ramMb, diskFreeGb |
| 22 | Status: kiosk phase, Staff App health | DD | report.kioskPhase, shellHealth |
| 23 | Status: lockdown level (raw "standard") | DD | report.lockdownLevel |
| 24 | Status: signing keys it trusts (hex ids) | DD TrustedKeys | report.trustedKeyIds |
| 25 | Lockdown: state pill, "Reported x ago" | LC Lockdown | G.apply |
| 26 | Lockdown: too-old agent / no report / refused / rolled back / refusal note / Home notice | LC | G.lockdownCapable, apply |
| 27 | Lockdown: 7 layers, each mode (Audit/Enforce/On), state pill, detail note | LC | apply.layers |
| 28 | Lockdown: group configuration version, last working version | LC | apply.configVersion, lkgVersion |
| 29 | Rollout ring select (admin) / text (viewer) | LC RingPicker | G.ring, rolloutRevision → rollouts:setRings |
| 30 | Apps on this PC table: app link, state, failure detail, updated, Retry (admin, confirm) | DD Installs | I → apps:retry |
| 31 | Policy: up to date / waiting (vA, latest vB) | DD | versions[0], report.appliedVersion |
| 32 | Policy: recent versions table (v, reason, published, applied) | DD versionCols | G.versions (5) |
| 33 | Compat: build.ubr (displayVersion), edition id, arch, S mode, domain/Entra joined | DD | report.compat.os |
| 34 | Compat: protection Full/Reduced + missing layers notice | DD | compat.protection, layers |
| 35 | Compat: WebView2 version, browsers found | DD | compat.webview2, browsers |
| 36 | Compat: blockers / warnings (codes → words, unknown raw) / "No blockers" / Lite mode line | DD | compat.blockers, warnings, liteMode |
| 37 | Settings: kiosk switch (admin; off needs fresh step-up) | DD Settings | fleet:setKiosk |
| 38 | Settings: group select + Move (admin) | DD Settings | G.groups (≤500) → fleet:move |
| 39 | Display and memory: mode select + Save, small-PC warning | DC | displayMode, groupDisplayMode → fleet:setDisplayMode |
| 40 | Lock this PC: lead, message, contact, live preview, Lock/Update/Unlock (major) | LK | G.lock → fleet:lock/unlock |
| 41 | Physical protection: verdict, Secure Boot, BitLocker, auto recovery, Safe Mode, TPM, service ACL, ACL repairs | LC Protection | G.protection |
| 42 | Allow USB: lead, state, hours select, Allow / End now | LC UsbAllow | G.usbAllowUntil → fleet:allowUsb |
| 43 | Identity: enrolled date, device ID (mono) | DD | G.enrolledAt, _id |
| 44 | Danger zone: Rotate credential, Revoke (type name), Remove (revoked only, type name) | DD Danger | fleet:requestCredentialRotation/revoke/remove |
| 45 | History table (paged, 10) | HP | A |
| 46 | Watch mode every 4 min while visible (not revoked) | DD useWatch | W |

Never on the page today but stored per PC: `deviceApplyReports.wifi[]` / `.printers[]` (state + detail code per
profile/printer), `driverResults` (per driver). They feed the new Network tab (decision D8).

## 2. Classification

Key: **H** header (every tab) · **O** Overview up front · **P** problem in "Needs attention" · tab name · **TD** one
click deeper ("Technical details" disclosure) · **ADV** Settings › Advanced · **X** removed.

| # | Goes to | Why |
|---|---|---|
| 1, 2 | H | Identity of the page. |
| 3, 4 | H (pills) | The two states asked for at a glance. |
| 5, 11 | P (warning) | A state with a "what to do" is a problem, not a pill. |
| 6 | H action | Frequent, per-PC. |
| 7 | H (pen icon next to the name) + Settings › General | Found where people look for it. |
| 8 | H pill "Locked" + P (danger, Unlock) | Most urgent state. |
| 9 | Replaces the problem list with one revoked banner | Nothing else matters for a revoked PC. |
| 10 | P (warning, "Choose a group") | Blocks every sign-in. |
| 12, 14 | P (danger), code + key ids + trust-key command in TD | Raw codes become plain words; support still gets the code. |
| 13 | P (info) | Nothing to click; Rulebox never restarts. |
| 15 | ADV (line under "Renew this PC's key") | Transient, technical. |
| 16 | H pill sub-line ("Online · 20 s ago") | Freshness of the state. |
| 17 | O About ("Last report") | Secondary. |
| 18 | H meta line "Rulebox 0.4.1" | Version asked for in the header. |
| 19, 20 | H meta "Windows 11 Home"; O About "Windows 11 Home, 24H2"; build in TD | Plain edition names (`Core` → Home). |
| 21 | O tile (free disk) + O About (memory, "Lite mode" note) | Numbers that matter. |
| 22 | H kiosk pill; Staff App health → P when unhealthy/failed; raw values in TD | Healthy is the normal case: say nothing. |
| 23 | X | `lockdownLevel` is a free-text code the agent sets to nothing today (`lockdown_level: None`, `apps/agent/src/backend/task.rs`); the Protection tab says the real state. |
| 24 | TD (About) | Hex ids are for support only. |
| 25–27 | Protection tab; refusals / failed layers also P | The detail belongs to its tab; the "what is wrong" goes up front. |
| 28 | TD (Protection) | Version numbers. |
| 29 | ADV, renamed "Gets changes" (First / Early / With everyone) | Rare, rollout concept. |
| 30 | Apps tab; failed count → O tile + P | One click deeper. |
| 31 | O tile "Settings: Up to date / Updating" ; vA/vB in TD | Plain words. |
| 32 | Activity tab, closed disclosure "Settings versions" (lazy query) | Technical; history already says what changed in words. |
| 33 | O About (Windows line, "Joined to a company domain" only when yes) + TD (build, edition id, arch, S mode) | Hide technical values. |
| 34 | Protection tab notice (info) | Not fixable from the dashboard; not a problem. |
| 35 | O About ("Browsers: Edge, Chrome"); WebView2 version in TD; missing WebView2 → P via compat warning | Plain. |
| 36 | Each blocker → P danger, each warning → P warning/info, Lite → About note; "No blockers" removed (the empty problem list says it) | One place for problems. |
| 37 | Settings tab; also P "Kiosk mode is off" with one-click "Turn kiosk on" | Automate the fix. |
| 38 | Settings › General (SearchSelect, options from the Settings-tab query) | Rare; options cost reads. |
| 39 | Settings tab | Rare. |
| 40 | H action "Lock this PC" → dialog (LockForm + preview); when locked the action reads "Unlock" | Urgent, must be reachable from every tab. |
| 41 | Protection tab (4 plain rows); TPM, service ACL, ACL repairs in TD; gaps → P info | Common gap, low urgency (D11). |
| 42 | Protection tab; open window → P info with "End now" | |
| 43 | Enrolled → O About; ID → TD | |
| 44 | Settings tab: Danger zone (Disconnect = revoke, Remove); rotate → ADV | One clear place. |
| 45 | Activity tab | |
| 46 | Page shell (unchanged behaviour) | |

## 3. Tabs

`PageTabs` + `useUrlTab(TABS, "overview")`; the default tab writes no `?tab=` (same as Settings). Unknown values fall
back to Overview. Panels render only the active tab (lazy chunks except Overview, D18).

| id | Label (phone label) | Holds | Data while open | Badge |
|---|---|---|---|---|
| `overview` | Overview | Stat tiles, Needs attention, About this PC | `fleet:page` + `fleet:liveness` (shared by the header) | count of danger+warning problems; danger tone if any danger |
| `apps` | Apps | Install results table, Retry | + `fleet:installs` (existing, paged) | failed installs (`n` / `n+`) |
| `protection` | Protection | Lockdown card, Physical protection, Allow USB | nothing extra (fields are in `fleet:page`) | count of lockdown problems (refused/rolled back/failed/partial layers) |
| `network` | Network and printers (Network) | Wi-Fi, printers, drivers for this PC and their state | + `fleet:network` | count of failed Wi-Fi + printers (from `fleet:page`, free) |
| `activity` | Activity | History; "Settings versions" disclosure | + `audit:forTarget` (paged); `fleet:versions` only while the disclosure is open | — |
| `settings` | Settings | General (name, group), Kiosk mode, Display and memory, Advanced, Danger zone | + `fleet:deviceSettings` | — |

A revoked PC shows only Overview, Activity, Settings (D17). Every tab is visible to viewers (read-only).

## 4. Layout per band

**Shared header** (`device/Header.tsx`, CSS in `device/device.css`):
- Row 1: back link. Row 2: h1 (name; `overflow-wrap:anywhere`, clamp 3 lines on phone / 2 on laptop, full name in
  `title`) + pen icon button (admin, aria "Rename"). Row 3 pills: presence (with "· 20 s ago" from liveness),
  kiosk, "Locked". Row 4 muted meta: `Group Back office` (link) · `Windows 11 Home` · `Rulebox 0.4.1`.
- Actions (admin, not revoked): ghost "Send a message", ghost "Lock this PC" / danger-ghost "Unlock". Right of the
  title on tablet+ (container query on the header ≥ 640 px); on phone a two-button row under the meta (50/50).
- **Sticky tab bar**: `position: sticky` under the shell top bar (phone/tablet) or at top 0 (laptop+). It carries a
  compact single-line name (truncated) that fades in (`opacity` + `translateY`, plain CSS, no animation with reduced
  motion / Lite) when the h1 leaves the viewport (IntersectionObserver). Phone: the tab strip scrolls sideways
  with the active tab kept in view (PageTabs).

**Main action rule:** the first problem's action is the page's one primary button. Header buttons are ghost. Tabs
without a problem have no primary button except the Save of a changed form.

| Band | Overview | Dense tab (Protection) | Other tabs |
|---|---|---|---|
| phone <600 | tiles 2×2; problems stacked, action full width under the text; About card last, dl one column | Lockdown, Physical protection, USB stacked; layer rows one column | Apps: DataTable card view per `lists-and-cards.md`; Settings cards stacked; Network cards stacked |
| tablet 600–1023 | tiles 4 across; problems full width (action right when the card ≥ 520 px, container query); About full width, dl 2 columns | Lockdown full width (layer rows 2 columns ≥ 560 px); Physical + USB `dash-grid--2` | Settings `dash-grid--2`; Network `dash-grid--2` |
| laptop 1024–1599 | tiles 4 across; `dash-split` main = Needs attention, aside = About (sticky below the tab bar when taller than the viewport is not needed: plain) | `dash-split`: main Lockdown, aside Physical protection + Allow USB | Apps: table full width; Activity: `dash-split` history / versions disclosure; Settings `dash-grid--2` + Danger zone full width; Network `dash-grid--2` (Drivers wraps) |
| wide ≥1600 | `dash-page` max 1480; tiles 5 across (adds Memory); `dash-split` 2:1 | `dash-split` 2:1 | Network `dash-grid--3` (Wi-Fi, Printers, Drivers); Settings `dash-grid--3` (General, Kiosk, Display) + Advanced and Danger zone side by side |

**Overview tiles** (`dash-grid--auto`, each a small card: label, value, optional sub): Settings (`Up to date` /
`Updating` / `Not sent yet`), Protection (`Working` / `Partly working` / `Not applied` / `Not reported yet`),
Apps (`No failures` / `2 failed`), Free disk (`183 GB`, warning tone with `low_disk`), wide only: Memory (`4 GB`,
sub `Lite mode`). A tile with a problem links to its tab.

Laptop 1366, Overview:
```
| < All devices                                                                    |
| OFFICE-SCANNER  [pen]                          [Send a message] [Lock this PC]    |
| (o) Online · 20 s ago   [Kiosk: problem]                                          |
| Group Back office · Windows 11 Home · Rulebox 0.4.1                               |
|==================================================================================|
| Overview (3) | Apps | Protection (1) | Network | Activity | Settings   <- sticky  |
|==================================================================================|
| [Settings      ] [Protection     ] [Apps         ] [Free disk    ]               |
| [Updating      ] [Partly working ] [No failures  ] [183 GB       ]               |
|                                                                                  |
| Needs attention                                  | About this PC                 |
| +--------------------------------------------+   | Windows 11 Home, 24H2         |
| |(!) This PC can't accept new settings        |   | Memory 4 GB · Lite mode       |
| |    It doesn't trust your signing key. Enroll|   | Free disk 183 GB              |
| |    it again with a new code. [Create a code]|   | Browsers Edge                 |
| |    > Technical details                      |   | Enrolled Nov 19, 2026         |
| +--------------------------------------------+   | Last report 2 hours ago       |
| | /!\ The Staff App is not running well   ...|   | > Technical details           |
| | /!\ Windows needs an update             ...|   |   ID, build, edition, keys... |
| +--------------------------------------------+   |                               |
| Also good to know (2)  v                         |                               |
```

Phone 390, Overview:
```
| < All devices            |
| OFFICE-SCANNER [pen]     |
| (o) Online · 20 s ago    |
| [Kiosk: problem]         |
| Back office · Windows 11 |
| Home · Rulebox 0.4.1     |
| [Send message][Lock PC]  |
|==========================|
| Overview(3) Apps Prot.. >|  <- sticky, scrolls sideways
|==========================|
| [Settings  ][Protection ]|
| [Updating  ][Partly     ]|
| [Apps      ][Free disk  ]|
| [No failure][183 GB     ]|
| Needs attention          |
| (!) This PC can't accept |
|     new settings         |
|     It doesn't trust ... |
|     [  Create a code   ] |
|     > Technical details  |
| /!\ The Staff App ...    |
| About this PC            |
| ...                      |
```

Laptop 1366, Protection:
```
| header + sticky tabs (Protection selected)                                        |
| Lockdown                      [Partly applied] | Physical protection             |
| Reported 2 hours ago                           | (!) Someone with the PC in hand  |
| (i) Windows Home: some program rules are not   |     could get around Rulebox.    |
|     available. Everything else applies.        |     Turn on Secure Boot and      |
| +-----------------------+-----------------------+     BitLocker on this PC.       |
| | Employee restrictions | PC restrictions       | Secure Boot          [Off]      |
| | On          [Working] | On          [Working] | BitLocker            [Suspended]|
| | Program rules         | Windows app control   | Automatic recovery   [Off]      |
| | Report only [Not supp]| Report only [Not supp]| Rulebox in Safe Mode [Yes]      |
| | ... (7 rows, 2 cols)  |                       | > Technical details             |
| +-----------------------+-----------------------+---------------------------------|
| > Technical details (config v4, last working v3)| Allow USB for this PC           |
|                                                 | The group's USB rules apply.    |
|                                                 | For [1 hour v]  [Allow USB]     |
```

Phone 390, Protection: Lockdown card (state pill under title, layers one column, TD), then Physical protection,
then Allow USB; each full width with 16 px gutters.

## 5. "Needs attention" model

`src/screens/device/problems.ts`: `deviceProblems(p: DevicePage, live: DeviceLiveness | null, now, role): Problem[]`,
pure, unit-tested. `Problem = { id, severity: "danger" | "warning" | "info", title, body, action?: ProblemAction,
tech?: { label, value }[] }`, `ProblemAction = { kind: "tab", tab, label } | { kind: "link", to, label } |
{ kind: "run", label, run: "kioskOn" | "unlock" | "endUsb" }` (runs go through the usual hooks; viewers get no
`run` actions and no admin-only links). Ordering: severity, then the table order. Danger + warning show on
Overview; info items sit in a closed "Also good to know (n)". Duplicates collapse (`desired_state_untrusted` and
`trustedKeyIds = []` are one problem). Codes are looked up in **one registry per source** (`KIOSK_ERRORS`,
`COMPAT_RULES`, `LOCKDOWN_RULES`) so new agent codes are one entry; an unknown code gives the generic title of its
source with the raw code in TD (never in the title).

| id | When | Sev. | Title | What to do (body) | Action |
|---|---|---|---|---|---|
| revoked | flags.revoked | danger (replaces the list) | This PC is disconnected from Rulebox | It gets no changes and keeps its last settings. Remove it, or enroll it again. | tab settings "Remove…" (admin) |
| locked | lock ≠ null | danger | This PC is locked | Nobody can sign in until you unlock it. | run unlock (admin) |
| suspended | planState suspended | danger | Your organization is suspended | PCs keep their last settings and get no changes. | — |
| neverSeen | report null and liveness never | info | Waiting for this PC to connect | Run the Rulebox installer on the PC with an enrollment code. | link /enrollment (admin) |
| untrusted | kioskError `desired_state_untrusted` or trustedKeyIds = [] | danger | This PC can't accept new settings | It doesn't trust your organization's signing key. Enroll it again with a new code. | link /enrollment (admin). TD: code, key ids, "On the PC as administrator: `rulebox-agent trust-key`" |
| kioskError | other kioskError (`KIOSK_ERRORS`) | danger | per code, e.g. `staff_account_conflict` "A Windows account already uses the staff name"; `password_policy` "Windows password rules blocked the staff account"; `access_denied`/`platform_error`/`state_not_saved` "Windows refused a change"; `guard_blocked` "Kiosk mode is switched off on this test PC"; `desired_state_invalid`/`catalog_invalid` "The PC could not read its settings"; `admin_exit_*_invalid` "The administrator exit settings are not valid"; compat blocker codes reuse COMPAT_RULES | per code: rename that account / Rulebox tries again by itself / update Rulebox on this PC / check Settings › Administrator exit | per code (link /settings?tab=adminExit for admin_exit_*; update link for owner) |
| kioskFailed | kioskPhase failed, no code | danger | Kiosk mode could not be turned on | Rulebox tries again by itself. If it stays, restart the PC. | — |
| lockdownRefused | apply.state refused | danger | This PC did not apply the lockdown settings | REFUSALS sentence (codes.ts), e.g. `managed_networks_empty` | per code: `managed_networks_empty` → link /networks; `admin_signin_unverified`, `lockout_threshold_too_low`, `would_*` → link /groups/:g/lockdown "Open group lockdown"; `journal_unknown_target`, `section_unknown_value` → update link |
| rolledBack | apply.state rolledBack | danger | This PC went back to its last working settings | The Staff App did not start with the new ones. It will not try that version again. Check the group's latest change. | link /groups/:g/lockdown |
| layerIssue | a layer `failed`/`partial` with a detail code (one per code, not per layer) | danger (failed) / warning (partial) | LAYER_DETAILS sentence, short form | registry "what to do" | per code (see slot below) |
| **adminTilesSlot** | layer detail `admin_signin_unverified` with layer state `partial` (the hideAdminTiles fix) | warning | Admin accounts stay visible on this PC | Until "Other user" sign-in is confirmed on this PC, Rulebox does not hide administrator accounts. Everything else is applied. To stop this message, turn off "Hide administrator accounts" for the group. | link /groups/:g/lockdown "Open group lockdown" |
| tooOld | lockdownCapable false | warning | Update Rulebox on this PC | This PC runs a Rulebox version from before lockdown. | owner: link /settings?tab=updates; others: body adds "Ask the owner." |
| staffApp | shellHealth unhealthy / failed | warning / danger | The Staff App is not running well / has stopped | Rulebox restarts it by itself. If this stays, restart the PC. | — |
| kioskOff | kioskEnabled false, not revoked | warning | Kiosk mode is off | This PC shows a normal Windows desktop. Turn kiosk mode back on after maintenance. | run kioskOn (admin; no step-up for on) |
| noGroup | flags.noGroup | warning | This PC is not in a group | No employee can sign in until it is in one. | tab settings "Choose a group" (focuses the picker) |
| overLimit | planState overLimit | warning | Over your plan's PC limit | This PC keeps its last settings and gets no changes. Remove PCs you no longer use. | link /devices |
| failedInstalls | failedInstalls.count > 0 | warning | "Zoom could not be installed" (1) / "3 apps could not be installed" | See which ones and try again. | tab apps "See apps" |
| network | failed Wi-Fi/printers in apply row | warning | "Wi-Fi could not be set up" / "2 printers could not be set up" | See which and why. | tab network |
| compatBlocker | each compat.blockers code (COMPAT_RULES) | danger | e.g. `s_mode` "Windows is in S mode", `managed_device` "The PC is joined to a company domain", `no_other_admin`, `legal_notice`, `shell_binary_missing`, `os_too_old`, `webview2_too_old` | per code (e.g. "Switch out of S mode in Windows settings", "Rulebox Setup installs it; run Setup again") | — |
| compatWarning | each compat.warnings code | warning: `low_disk`, `protected_print_on`, `webview2_missing`; info: `low_ram`, `arm64_untested` | as COMPAT_CODES, shortened | per code | — |
| offline | offline and `presence.since` > 24 h ago | warning | Offline for 3 days | Check that the PC is on and connected. Changes reach it when it is back. | — |
| outOfSupport | summary.outOfSupport | warning | Windows needs an update | This Windows version no longer gets security fixes. Update Windows on this PC. | — |
| restart | report.restartPending or a layer `restartPending` | info | Restart needed | Restart the PC when nobody is using it. Rulebox never restarts it by itself. | — |
| usbOpen | usbAllowUntil > now | info | USB devices are allowed until 15:00 | It ends by itself. | run endUsb (admin) |
| physical | protectionGaps non-empty | info | Someone with the PC in hand could get around Rulebox | Turn on Secure Boot and BitLocker on this PC. | tab protection "See details" |

Empty list: a success card "Nothing needs your attention" (+ "Last report 2 hours ago").

**How device warnings reach the dashboard today** and where the hideAdminTiles warning plugs in: the agent sends
`deviceApi:reportApply` (`convex/deviceApi.ts`) with `layers.<name>.{mode,state,detail}` as fixed codes; it is
stored in the one `deviceApplyReports` row per PC, returned by `fleet:get` as `apply` (and by `fleet:page`), and
turned into words by `screens/lockdown/codes.ts` (`LAYER_DETAILS.admin_signin_unverified` already exists). The
agent today *refuses* the whole apply with that code (`machine.rs:243`, `invariants.rs`). After the fix it will apply
the rest and report the `machine` layer as `partial` with detail `admin_signin_unverified`, so the slot is the
`LOCKDOWN_RULES["admin_signin_unverified"]` registry entry (row "adminTilesSlot" above) — no server change. If the
other agent chooses another channel (e.g. a new `warnings: string[]` on the apply report or `deviceReports`), add it
to `DevicePage`, the `fleet:page` return and `devicePageOf`, and feed it to the same registry; the problem row stays.
The old refusal (agents before the fix) keeps the `lockdownRefused` row with the same "Open group lockdown" action.

## 6. Data

### 6.1 Queries (all `memberQuery("viewer")`, all in `convex/fleet.ts` so `_generated/api.d.ts` needs no regeneration)

**`fleet:page({ deviceId })`** — header + Overview + Protection. Subscribed for the whole page.
```ts
{ _id, name, revision, kioskEnabled, enrolledAt, revoked: boolean,
  group: { _id, name } | null, displayMode, groupDisplayMode,
  presence: { online, since, revoked },
  outOfSupport: boolean,                       // summary
  report: reportValue | null,                  // as fleet:get (incl. compat, trustedKeyIds, restartPending)
  latestVersion: number | null, planState: "ok" | "overLimit" | "suspended" | null,   // head
  flags: { noGroup, revoked, rotateCredential },
  lock: {...} | null,
  ring, usbAllowUntil, protection, lockdownCapable, apply,                  // as fleet:get (no rolloutRevision)
  failedInstalls: { count: number, more: boolean, names: string[] /* <= 2 */ },
  network: { wifiFailed: number, printersFailed: number } }                 // counted from the apply row
```
Reads: device, credentials, presence, summary, report (compat ≤ 32 KB), head (~250 B), apply (~2.5 KB), lock,
group (`db.get`, not the 500-group list), then `installResults.by_device_state_updated` (new index
`["deviceId","state","updatedAt"]`) `.eq(device).eq("failed").order("desc").take(10)` filtered with
`liveChecker` (`lib/installs.ts`: ≤10 app gets + ≤10 assignment lookups, memoized). Worst case 3 + 9 + 30 = 42
reads, ~60 KB. Re-runs on: a change of this PC's device, credentials, presence, summary, report or apply row,
head (each publish to it), lock, its group row, a failed result of this PC entering/leaving the range, or one of
those apps/assignments. No liveness, no bodies (passes `NEVER_SUBSCRIBE`).
Budget: `"fleet:page": { maxReads: 44, maxReadBytes: 64_000, maxWrites: 0, maxWriteBytes: 0, live: true }`.

**`fleet:deviceSettings({ deviceId })`** — Settings tab. `{ groups: { _id, name }[] /* sorted, ≤ 500 */, rolloutRevision: number }`.
Reads: device + `groups.by_org` `.take(MAX_GROUPS_JOINED)` + `groupRollouts.by_group` (1). Worst 3 + 1 + 500 + 1
= 505 reads / ~150 KB (500 groups is the cap; typical orgs < 20). Re-runs on any group change of the org, only
while the tab is open. Budget `maxReads: 505, maxReadBytes: 160_000, live: true`.

**`fleet:versions({ deviceId })`** — Activity disclosure. `{ version, createdAt, reason }[]` (`desiredVersions.by_device_version`
desc `.take(KEEP_VERSIONS)`). 3 + 1 + 5 = 9 reads / ~2 KB. Budget `maxReads: 9, maxReadBytes: 4_096, live: true`.

**`fleet:network({ deviceId })`** — Network tab.
```ts
{ groupId: Id | null, reportedAt: number | null,
  wifi: { _id, name, state: "working" | "failed" | "waiting" | "notSupported", detail: string | null }[],
  printers: { _id, name, isDefault: boolean, state: same, detail: string | null }[],
  drivers: { _id, name, state: InstallState, detail: string | null }[] }
```
Reads: device, apply row, `wifiProfiles.by_org` take(51), `printers.by_org` take(101), `drivers.by_org` take(51)
(all three tiny bounded tables; keep rows whose `groupIds` include the PC's group), `driverResults.by_device_driver`
`.eq(deviceId)` take(51). State per item from the apply row's `wifi[]` / `printers[]` (same buckets as
`networks.ts bucketOf`; missing = waiting). Never a passphrase, box, URL or hash. Worst 3 + 2 + 254 = 259 reads,
~140 KB; typical < 20. Re-runs on any Wi-Fi/printer/driver edit of the org, this PC's apply row or driver results,
only while the tab is open. Budget `maxReads: 260, maxReadBytes: 150_000, live: true`.

Unchanged: `fleet:liveness` (header, the one allowed `deviceLiveness` reader), `fleet:watch`, `fleet:installs`
(Apps tab), `audit:forTarget` (Activity), every mutation.

**`fleet:get`**: no longer called by the dashboard. Kept unchanged for one release so a dashboard bundle older than
the server keeps working during a deploy; mark it `DEPRECATED (UI pass 2026-11)` and add a `follow-ups.md` entry to
delete it with its `ioBudgets`/`matrixRows` rows and move its Convex tests (`fleet.test.ts`, `lockdown.test.ts`
380, `broadcasts.test.ts` 83, `displayMode.test.ts` 161, `keys.test.ts` 297) to `fleet:page`.

Subscriptions per tab: Overview/Protection 2 (`page`, `liveness`); Apps, Network, Settings 3; Activity 3 (+1 while
the versions disclosure is open). Today: 4 at once (`get`, `liveness`, `installs`, `forTarget`), with `get`
reading up to 500 groups on every re-run.

### 6.2 Seam (`src/data`)

- `types.ts`: `DeviceDetail` → reshaped as **`DevicePage`** (fields above, report mapped as today); keep
  `DeviceDetail` as a deprecated alias only if a test needs it, else delete. `DeviceLockdown` drops
  `rolloutRevision`. New `DeviceSettingsOptions`, `DeviceNetwork` (+ `NetworkItemState`). Components take narrow
  `Pick`s: `LockCard`/`LockDialog` `Pick<DevicePage,"_id"|"revoked"|"lock">`, `DeviceDisplayCard`
  `Pick<DevicePage,"_id"|"revision"|"revoked"|"displayMode"|"groupDisplayMode"> & { ramMb?: number }`.
- `api.ts`: `useDeviceDetail` → `useDevicePage(deviceId): QueryState<DevicePage>` (main seam: the header is on the
  entry path of the lazy screen only, so it may move to the devices seam too — keep it where `useDeviceDetail`
  is to limit churn). Devices seam (`data/devices/api.ts`, lazy): `useDeviceSettingsOptions(deviceId)`,
  `useDeviceVersions(deviceId, enabled)`, `useDeviceNetwork(deviceId)`.
- Live: `live/hooks.ts` `useDevicePage` → `api.fleet.page` mapped by `devicePageOf` (`live/devices.ts`, replaces
  `deviceDetailOf`; tolerant of absent fields). `lockdown/live.ts` `useDeviceLockdown` → `api.fleet.page` (same
  args as the page: still one subscription), `deviceLockdownOf` reads the page result. `devices/live.ts`: the three new hooks.
- Demo: `demo/hooks.ts` `useDevicePage` builds the same shape (failed installs from `db.installs` live rules,
  `planState` and head version from the device fixture/versions, network counts from the new demo apply items);
  `demo/lockdown.ts` `deviceLockdownOf` drops `rolloutRevision`; demo devices seam gets the three hooks.
  `fixtures/seed.ts`: add `wifi[]`/`printers[]` results to `applyDetails` and a few `driverResults` (OFFICE-SCANNER:
  Wi-Fi "Shop floor" `failed` + `connect_failed`; COUNTER-02: a printer `waiting`); add one PC whose machine layer is
  `partial` + `admin_signin_unverified` so the hideAdminTiles slot is visible in demo.
- `data/README.md`: update the device rows.

## 7. Strings

New files (per-tab, so parallel builders do not collide): `screens/device/strings.ts` (header, tabs, tiles, About,
TD), `device/problemStrings.ts` (section 5 titles/bodies/actions), `device/settingsStrings.ts`,
`device/networkStrings.ts`. `lib/screenStrings/device.ts` keeps what HistoryPanel and the tests still import
(`history`, rename, revoke/remove texts) and loses the moved keys. Plain labels and (i) texts:

| Key | Label | (i) text |
|---|---|---|
| tabs | Overview · Apps · Protection · Network and printers (Network) · Activity · Settings | — |
| presence | Online · 20 s ago / Offline since 14:05 / Not connected yet | "Online means the PC is talking to Rulebox now." |
| tile.settings | Settings: Up to date / Updating / Not sent yet | "Whether this PC runs the latest settings of its group. It updates within a minute when online." |
| tile.protection | Protection: Working / Partly working / Not applied / Not reported yet | "How much of the group's lockdown this PC applies. Details on the Protection tab." |
| tile.apps | Apps: No failures / 2 failed | — |
| tile.disk | Free disk | "Below 2 GB, app installs and updates can fail." |
| about | About this PC: Windows, Memory (+ "Lite mode"), Free disk, Browsers, Joined to a company domain (only if yes), Enrolled, Last report | Lite mode: "On PCs with 4 GB or less, Rulebox keeps fewer windows open to stay fast." |
| td | Technical details (with "Copy") | "For support. You don't need these to use Rulebox." |
| edition | Core*, CoreSingleLanguage → Home; Professional → Pro; Enterprise; Education; IoTEnterprise → IoT Enterprise; unknown → raw | — |
| layers | Employee restrictions · PC restrictions · Program rules · Windows app control · Program watch · Start-up and tamper protection · Speed settings | one (i) per layer, e.g. Program rules: "Only programs you allow can start." |
| modes | words from `lockdown.md` (until then: Off / Report only / Blocking / On) | — |
| ring | Gets changes: First (pilot) / Early / With everyone | "PCs set to First get every change before the others, so you can check it on one PC." |
| rotate | Renew this PC's key | "Gives the PC a new secret at its next check-in. Use it if you think the PC's key was copied." |
| revoke | Disconnect this PC | "The PC stops getting changes and keeps its current settings. You can enroll it again later." |
| remove | Remove this PC | "Deletes its reports and history from Rulebox. The audit log keeps a record." |
| kiosk | Kiosk mode | "Off shows a normal Windows desktop, for maintenance. Turn it back on when you are done." |
| display | Display and memory | existing `displayStrings`, long hints moved to `info` |
| usb | Allow USB for this PC | "Keyboards, mice and touch screens always work." (moved from the body) |
| versions | Settings versions | "Each change to this PC's settings makes a new version." |
| network | Wi-Fi networks / Printers / Drivers; states Working / Failed / Waiting / Not supported | "Set up for this PC's group on the Networks page." |
| empty | "Nothing needs your attention" · "This PC has not sent this yet." · "No Wi-Fi networks for this group" (+ "Add one" link, admin) | — |

## 8. Edge cases

- **Never seen** (no report, liveness `null`): pill "Not connected yet"; tiles show "—"; one info problem with the
  enrollment link; Protection/Network say "This PC has not sent this yet"; watch mode still runs (as today).
- **Offline**: pill "Offline since …" (absolute time in `title`); tiles show the last known values with a sub-line
  "Last known, 2 hours ago" when `report.updatedAt` is older than 1 h; problem only after 24 h (D12).
- **Revoked**: tabs Overview/Activity/Settings; Overview shows only the revoked banner + About; Settings shows the
  Danger zone with Remove (others disabled/hidden); no watch, no header actions (as today).
- **Very long name** (`WAREHOUSE-RECEIVING-DOCK-EAST-TERMINAL-02-LEGACY-…`): h1 breaks anywhere, 2–3 line clamp
  with full text in `title` and in the accessible name; sticky label one line with ellipsis; header actions wrap
  under the title, never push the page wider; `document.title` uses the full name; confirm dialogs keep
  "type the name" (unchanged).
- **Home edition**: About says "Windows 11 Home"; Protection shows the neutral notice and AppLocker/App Control rows
  "Not supported"; no problem raised for it.
- **Older agent** (no compat Phase 6 fields, no `trustedKeyIds`, `lockdownCapable` false): fields hidden, never a wrong
  value; `tooOld` problem. **Older server** (no `fleet:page`): not supported — the server deploys first (6.1).
- **Unknown codes**: generic title per source, raw code in TD only.
- **Roles** (server enforces; UI mirrors): viewer reads every tab, sees problems without `run` actions and without
  admin-only links (enrollment, Settings › Updates), sees Settings values as text. Admin: every action; kiosk off,
  lock/unlock, revoke and remove ask for the fresh step-up as today. Owner: as admin, plus the "Update Rulebox"
  link to Settings › Updates (owner-only page).
- **Loading / error per tab**: page query loading → header skeleton (title bar, pills) + Overview skeleton; error →
  `QueryRegion` alert (not_found without Try again, as today). A tab query loading → that panel's skeleton; its error
  → an alert with Try again inside the panel, header stays. Liveness failing → "—", never "Not connected yet".
  Switching tabs keeps the page query (no flash); a tab chunk loading shows the panel skeleton (Suspense).
- **Another PC** (route id changes): keyed by id so tab state, paging and open disclosures reset; the history panel
  keeps its "no foreign rows while loading" rule.
- **Many problems**: all danger+warning shown (they are few by construction: one per code), info collapsed.

## 9. Tests

Update (each build step updates the tests of what it touches):
- `screens/step7.test.tsx` "DeviceDetail": `fleet:get` → `fleet:page` in fixtures (`detail()` drops `groups`,
  `versions`, `state`; adds `outOfSupport`, `failedInstalls`, `network`); trusted keys test → keys appear in About
  TD, empty list raises the `untrusted` problem title; compat card tests → About values (WebView2 version in TD,
  "Edge, Chrome"), Reduced → Protection tab notice, codes → problem titles; "subscribes to liveness next to
  fleet:page" stays; move test → open `/devices/d1?tab=settings`, `fleet:deviceSettings` result, SearchSelect
  interaction; kiosk-off step-up test → `?tab=settings`; revoke test → Settings Danger zone label "Disconnect this
  PC"; viewer test per tab.
- `screens/step17.test.tsx` "DeviceDetail: installs and history": installs on `?tab=apps`, history on
  `?tab=activity` (split the combined test); "empty page offers Next" on `?tab=apps`.
- `screens/step19.test.tsx` "the device page cards": "same query and arguments" → `fleet:page`; older-server test
  without lockdown fields; ring tests move to the Settings tab (rolloutRevision from `fleet:deviceSettings`);
  layer mode words follow `lockdown.md`.
- `screens/step15.test.tsx` LockCard and `screens/display.test.tsx` DeviceDisplayCard: fixtures shrink to the Picks.
- `data/live/devices.test.tsx`: `useDevicePage` subscribes `fleet:page` and maps (absent fields tolerated); the
  three new hooks pass args; `useDeviceVersions(…, false)` subscribes nothing.
- `data/demo/demo.test.tsx` (478, 632) and `demo/lockdown.test.tsx`: new hook names/shape.
- `convex/ioBudgets.test.ts` needs the four new rows in `ioBudgets.ts` and `tests/convex/matrixRows.ts`
  (`{ ...VIEWER, foreign: "not_found" }`); measure with `IO_REPORT=1` and write MEASURED comments.
New:
- `convex/fleet.test.ts` "device page queries": page shape; foreign id `not_found`; failed count counts only live
  results (unassigned app, archived app, other group tag, revoked → 0), `more` at 10, `names` ≤ 2; planState /
  latestVersion from the head; network counts from the apply row; `deviceSettings` groups sorted + rollout
  revision (0 without a row); `versions` ≤ 5 newest first; `network` keeps only the group's items, maps states,
  never returns a passphrase/url/sha256.
- `screens/device/problems.test.ts`: one test per row of section 5 (incl. the adminTiles slot and an unknown code
  of each source), ordering, untrusted dedupe, viewer gets no `run` actions, owner-only update link.
- `screens/device/deviceTabs.test.tsx`: `?tab=` round trip (replace history), unknown tab → Overview, revoked → 3
  tabs, **a tab that is not open subscribes nothing** (Overview: only `fleet:page` + `fleet:liveness`; Apps adds
  only `fleet:installs`; Activity adds `fleet:versions` only after the disclosure opens), badges.
- `screens/device/network.test.tsx`: states, empty states, admin link to /networks.

## 10. Build steps

Each step: one Sonnet agent, runs `pnpm --filter @rulebox/dashboard typecheck` + lint + its tests (Convex steps:
`pnpm test:convex`), never `convex dev/deploy`, never commits. ∥ = may run in parallel with the steps named.

1. **Types and seam signatures** (main session or one agent, first): `data/types.ts` (`DevicePage`,
   `DeviceSettingsOptions`, `DeviceNetwork`, `DeviceLockdown` minus `rolloutRevision`), `data/api.ts`,
   `data/devices/api.ts` signatures only. Unblocks 2–4.
2. **Convex queries** ∥3, ∥4: `schema.ts` index `installResults.by_device_state_updated`; `fleet:page`,
   `fleet:deviceSettings`, `fleet:versions`, `fleet:network` in `fleet.ts`; `fleet:get` DEPRECATED comment;
   `ioBudgets.ts`; `tests/convex/matrixRows.ts`; `convex/fleet.test.ts` new describe; `pnpm test:convex`
   (ioBudgets + fleet + lockdown).
3. **Problems model** ∥2, ∥4: `screens/device/problems.ts`, `problemStrings.ts`, `problems.test.ts` (pure; codes
   from `screens/lockdown/codes.ts` and the COMPAT map moved from `lib/screenStrings/device.ts`).
4. **Shell** ∥2, ∥3 (needs foundations' `PageTabs`/`useUrlTab`; if not merged yet, code against the README
   contract): `screens/DeviceDetail.tsx` becomes page query + header + tabs + lazy panels; `device/Header.tsx`
   (sticky bar, compact name, actions, RenameDialog kept), `device/TechnicalDetails.tsx` (`dash-advanced` +
   Copy), `device/strings.ts`, `device/device.css`; `LockDialog` wrapping `LockForm` (export it from
   `broadcasts/LockCard.tsx`, narrow its props). Tab panels as stubs.
5. **Live + demo seam** (after 1, 2): `live/hooks.ts`, `live/devices.ts` (`devicePageOf`), `lockdown/live.ts`,
   `devices/live.ts`, `demo/hooks.ts`, `demo/lockdown.ts`, demo devices hooks, `fixtures/seed.ts` additions,
   `data/README.md`; `live/devices.test.tsx`, `demo/*.test.tsx`.
6. **Overview tab** (after 3, 4, 5) ∥7, ∥8, ∥9: `device/OverviewTab.tsx` (tiles, problem cards with run actions,
   info disclosure, About + TD); step7 tests for the header/Overview.
7. **Apps + Activity tabs** (after 4, 5) ∥6, ∥8, ∥9: `device/AppsTab.tsx` (move `Installs` out of DeviceDetail;
   empty state links to the group), `device/ActivityTab.tsx` (HistoryPanel + lazy versions disclosure); step17 tests.
8. **Protection tab** (after 4, 5) ∥6, ∥7, ∥9: `device/ProtectionTab.tsx`; refactor `lockdown/DeviceCards.tsx`
   (plain layer names + (i), modes per `lockdown.md`, versions and TPM/ACL rows into TD, 2-column layer grid by
   container query, RingPicker exported for step 9); `deviceStrings.ts`; step19 device-card tests.
9. **Settings tab** (after 4, 5) ∥6, ∥7, ∥8: `device/SettingsTab.tsx` (General: name + Rename, group SearchSelect
   + Move; Kiosk; `DeviceDisplayCard` with narrowed props; Advanced: ring picker with `rolloutRevision` from
   `useDeviceSettingsOptions`, Renew key + pending line; Danger zone), `settingsStrings.ts`; step7 move/kiosk/revoke
   tests, display.test, step15.
10. **Network tab** (after 2, 5) ∥6–9: `device/NetworkTab.tsx`, `networkStrings.ts`, `network.test.tsx`. Separable:
    if dropped, remove the tab id and `fleet:network` (D8).
11. **Wire-up and tab tests** (after 6–10): badges, revoked tab set, `deviceTabs.test.tsx`; remove dead code from
    `lib/screenStrings/device.ts` and `DeviceDetail.tsx`.
12. **Verify** (main session): `pnpm ci:check`; size budget (`scripts/size.mjs`; DeviceDetail must shrink — tabs are
    lazy; report any raise); screenshots `device`, `device?tab=protection|settings|network`, `deviceLong` at
    390/820/1366/1920 light+dark into `.tmp/ui-pass/device/` on port 4341; `follow-ups.md` entry "delete
    fleet:get"; tell the owner the PRD notes below.

PRD/owner notes (behaviour): (1) PRD 11.1 rule 1 is read as "one query for the page header plus one per open tab"
(lists keep their own paged query, as today); (2) the Network tab newly shows per-PC Wi-Fi/printer/driver results
already stored (PRD 24.2 unchanged); (3) "Revoke" is labelled "Disconnect this PC" in the UI only (mutation, audit
action and PRD term unchanged); (4) the rollout ring moves to Settings › Advanced (PRD 24.3 unchanged). No Section 21
decision is reopened.

## 11. Decisions taken

| # | Decision | Options considered | Taken |
|---|---|---|---|
| D1 | Tab split | (a) 6 tabs Overview/Apps/Protection/Network/Activity/Settings; (b) 5, Network folded into Protection; (c) 4 (Overview/Apps/Protection/More) | (a): each group has its own data and users; Network has real failures to show |
| D2 | Query shape | (a) one page query for header+Overview(+Protection) and one per other tab; (b) every tab a full query incl. the header (duplicate reads, header flicker); (c) keep one `fleet:get` | (a) |
| D3 | Old query | (a) new `fleet:page`, keep `fleet:get` one release, then delete; (b) reshape `fleet:get` in place (breaks an older bundle during deploy) | (a) |
| D4 | Protection tab data | (a) from `fleet:page` (rows already read, ~1 KB more); (b) own query | (a): zero extra reads |
| D5 | Group picker options | (a) Settings-tab query; (b) in the page query (today: 500 groups per re-run); (c) only while a Move dialog is open | (a): simple, only while the tab is open |
| D6 | Policy versions table | (a) Activity, closed disclosure with a lazy query; (b) drop; (c) keep the table | (a) |
| D7 | Failed-install count on Overview | (a) new index + `.take(10)` + live check; (b) per-device counter in `deviceSummary` (more write paths); (c) none on Overview | (a) |
| D8 | Network tab | (a) build it (last, separable); (b) leave per-PC network results unseen | (a) |
| D9 | Where problems are derived | (a) client, pure function over raw codes; (b) server returns problem objects | (a): no server change per new code, easy tests |
| D10 | hideAdminTiles warning | (a) registry entry on the layer detail code; (b) new server field | (a), (b) only if the other agent adds one |
| D11 | Physical protection gaps | (a) info ("Also good to know"); (b) warning | (a): common and not urgent; avoids alarm fatigue |
| D12 | Offline as a problem | (a) only after 24 h; (b) always; (c) never | (a) |
| D13 | Lock this PC | (a) header action → dialog; (b) card in Settings; (c) card on Overview | (a): reachable from every tab |
| D14 | Rollout ring | (a) Settings › Advanced, "Gets changes"; (b) Protection tab | (a) |
| D15 | Rotate credential | (a) Settings › Advanced "Renew this PC's key"; (b) Danger zone | (a) |
| D16 | Revoke wording | (a) "Disconnect this PC"; (b) keep "Revoke" | (a), UI only |
| D17 | Tabs of a revoked PC | (a) Overview/Activity/Settings; (b) all six, mostly empty | (a) |
| D18 | Tab code | (a) Overview eager, other tabs lazy chunks; (b) all eager | (a): keeps DeviceDetail under its 25.5 KB budget |
| D19 | Sticky behaviour | (a) sticky tab bar with a fading compact name; (b) whole header sticky (too tall on phones); (c) nothing sticky | (a) |
| D20 | Stat tiles | (a) Overview only, header compact; (b) on every tab | (a) |
| D21 | Kiosk off | (a) warning with one-click "Turn kiosk on"; (b) info only | (a): automates the fix |
| D22 | Technical values | (a) one `TechnicalDetails` disclosure with Copy per card/problem; (b) a separate "Technical" tab | (a) |
| D23 | Edition names | (a) map `EditionID` to Home/Pro/…; (b) show raw | (a), raw in TD |
| D24 | `lockdownLevel` | (a) remove (never set by the agent); (b) keep | (a) |
| D25 | Links into other pages | `/settings?tab=updates`, `/settings?tab=adminExit`, `/groups/:id/lockdown`, `/networks`, `/enrollment` | taken; re-check ids against `settings.md`, `lockdown.md`, `enrollment-networks.md` when those land |
