# UI pass: Add a PC (`/enrollment`) and Networks (`/networks`, Wi-Fi, printer, driver forms)

Status: planned 2026-11-28, decisions taken with the recommended option (see "Decisions taken"); owner reviews later.
Binding: repo `CLAUDE.md`, `docs/plans/ui-pass/README.md` (owner rules, width bands, component contract),
`docs/plans/follow-ups.md` "NEXT after VM run A3" (sections 4, 5, "Users are not technical", "Automate the complex
things"), PRD 9.1 (enrolling a PC), 14 (compatibility check), 24.2 (Wi-Fi, printers, drivers).

Builds on the shared pieces named in the README contract: `Select`, `SearchSelect`, `InfoTip`, `Field info`,
`dash-page`, `dash-grid--2|--3`, `dash-split`, `dash-form-grid`, `dash-advanced`, generic table + Cards view
(`lists-and-cards.md`). Where this plan needs something extra from those, it says so under "Dependencies".

---

## 1. Inventory (today)

### 1.1 `/enrollment` (`screens/Enrollment.tsx`, `screens/enrollment/{model,strings}.ts`, `enrollment.css`)

| # | Item | Kind | Where |
|---|---|---|---|
| E1 | Title "Enrollment", lead "One-time codes that add a PC…" | text | PageHeader |
| E2 | "Create code" | header action (admin) | opens CreateDialog |
| E3 | "Create a group first" + "New group" link | notice | when 0 groups |
| E4 | Group | native select, required | CreateDialog |
| E5 | Number of PCs (1–100) | number input + hint | CreateDialog |
| E6 | Valid for: 15 min / 1 h / 1 day / 7 days / Custom… | select | CreateDialog |
| E7 | Custom length + unit (min/h/days) | number + select | CreateDialog (custom) |
| E8 | Label (optional, ≤ 64) + hint | text | CreateDialog |
| E9 | Plan usage "n of m active codes in use on the X plan" | text | CreateDialog |
| E10 | Server errors (plan_limit, not_found group, not_ready, invalid_argument) | inline | CreateDialog |
| E11 | One-time panel: warning "shown only now", code in blocks, Copy field | panel | after create |
| E12 | Meta "For n PCs in group G. Expires …. Upper and lower case…" | text | panel |
| E13 | How-to: run installer + paste; CLI `rulebox-agent enroll <code>` | text | panel |
| E14 | "Done, hide the code" | button | panel |
| E15 | Codes table: Code(label), Group link, Uses "x of y used", Created, Expires (sortable), State pill, Created by, Revoke | ServerTable | page |
| E16 | Empty state "No codes yet." | EmptyState | table |
| E17 | Revoke confirm (type the label, fresh step-up) | dialog | table |

### 1.2 `/networks` (`screens/Networks.tsx`, `networks/ApprovedDrivers.tsx`, `networks/strings.ts`)

| # | Item | Kind |
|---|---|---|
| N1 | Title "Networks", lead about Wi-Fi only (wrong: page also has printers/drivers) | text |
| N2 | Header actions: New Wi-Fi network, New printer, New driver (3 primaries) | links |
| N3 | Read-only notice (viewer) | notice |
| N4 | Wi-Fi item: icon, name link, SSID (mono) · security short, Hidden chip, password status, 4 group chips + "+N more", Edit | list item |
| N5 | Printers card + long lead; item: name, kind short · address(:port / queue), "Driver: X", default badge, group chips, Edit | list item |
| N6 | Drivers card + long lead; item: name, kind chip, class chip, "Provides: …", group chips, Edit | list item |
| N7 | Big centred EmptyState per section | empty |
| N8 | Approved printer drivers card: built-in chips, added chips (×), "Delivered by Rulebox: …", add field + Add name, Save names | card form |

### 1.3 `/networks/wifi/:id` (`WifiEdit.tsx`, `networks/PassphraseDialog.tsx`, `lib/wifiRules.ts`)

| # | Item | Kind |
|---|---|---|
| W1 | Name (+ hint "Only for you…") | text, required |
| W2 | Network name (SSID) (+ hint + "n of 32 bytes") | text mono, required |
| W3 | Security (4 options) + per-option help | select |
| W4 | Hidden network + hint | switch |
| W5 | Join automatically + hint | switch |
| W6 | Groups checklist + hint | checkboxes |
| W7 | "The password is set separately, in the Password card." | note (new only) |
| W8 | Add network / Save changes; Cancel / "unsaved" | actions |
| W9 | Header chips: SSID, security, Hidden | detail |
| W10 | Password card: status (Set on … / Not set warning / open), Set/Replace → PassphraseDialog (lead, password + hint) | card + modal |
| W11 | "On the PCs" counts: Joined or ready / Waiting for password / Failed / No Wi-Fi adapter + sample line | card |
| W12 | Remove network (type name) | danger card |
| W13 | History panel | card |
| W14 | Read-only key/value view (viewer) | card |

### 1.4 `/networks/printers/:id` (`PrinterEdit.tsx`, `lib/printerRules.ts`)

| # | Item | Kind |
|---|---|---|
| P1 | Name (+ hint "Shown in the Print window… (Rulebox)") | text, required |
| P2 | How the printer is reached: IPP / Raw TCP 9100 / LPR / Shared (+ help) | select |
| P3 | Address (label + hint per kind) | text mono, required |
| P4 | Port (raw only, empty = 9100) | text |
| P5 | Queue name (LPR only) | text, required for LPR |
| P6 | Driver (approved list; "delivered" / "not listed" tags) + long hint | select |
| P7 | Groups checklist | checkboxes |
| P8 | Default printer: per selected group "Default in G" | checkboxes |
| P9 | Counts (Set up / Failed), Remove, History, read-only view | cards |

### 1.5 `/networks/drivers/:id` (`DriverEdit.tsx`, `lib/driverRules.ts`)

| # | Item | Kind |
|---|---|---|
| D1 | Rules notice (https, SHA-256, signature, no window, not an app) | notice |
| D2 | Name (+ hint) | text, required |
| D3 | Device class: Printer / Scanner / Other (+ USB-rules hint) | select |
| D4 | What you are delivering: driver package zip / .exe / .msi (+ help) | select |
| D5 | Download link (https) | url, required |
| D6 | SHA-256 (64 hex) | text, required |
| D7 | Size in bytes | text, optional |
| D8 | INF file inside the zip (inf only) | text, required for inf |
| D9 | Silent arguments, one per line (exe only) | textarea, required for exe |
| D10 | Extra success exit codes (exe only) | text |
| D11 | Printer driver names it delivers (provides) | textarea |
| D12 | Groups checklist | checkboxes |
| D13 | Counts (Installed / Waiting / Restart / Failed / Removed / Not usable), Retry card, Remove, History | cards |

---

## 2. Classification

Legend: **Up** = up front, **1-deeper** = one click (dialog, (i), disclosure that is not "Advanced"), **Adv** = inside
`dash-advanced`, **Auto** = filled by Rulebox, **Remove**.

### 2.1 Enrollment

| Item | Place | Plain label | Reason / automation |
|---|---|---|---|
| E1 | Up | Title **"Add a PC"**, lead "Three steps. The new PC shows up here by itself." | The task, not the mechanism |
| E2 | Remove | – | The wizard's step 1 is the main action; no dialog |
| E3 | Up (step 1) | "Your PCs need a group first." + inline quick create (name field, default "My PCs") | Never send the user away (`useCreateGroup`) |
| E4 | Up, **picker with default** | "Joins the group" (`SearchSelect` when > 6 groups, else `Select`) | Default = group used last in this browser (localStorage, try/catch), else the only group, else first by name |
| E5 | Up, **stepper** | "How many PCs?" − 1 + | Default 1; 1–100; plain words |
| E6 | Adv, **default** | "Code works for" 1 hour / 1 day / 7 days | Default 1 day; most users never touch it |
| E7 | Remove | – | Custom lifetime dropped (presets 15 min, 1 h, 1 day, 7 days cover it; server bounds unchanged) |
| E8 | Adv, **Auto** | "Name of the code" | Auto label `"{group} · {28 Nov}"` (≤ 64, group name truncated), editable under Advanced |
| E9 | 1-deeper | shown only near/at the limit, inline | Noise otherwise |
| E10 | Up, inline | own sentences (existing `enrollErrorMessage`) + "Revoke an unused code" link at plan_limit | Errors stay visible |
| E11 | Up (step 2) | Big code, **Copy** (primary), **Download Rulebox**, **QR code** | One click each |
| E12 | (i) | "Works for 1 PC until tomorrow 14:05" visible; case note in (i) | Short |
| E13 | Up 3 short lines; CLI + silent command in Adv | "Install without clicks (for IT)" | Technical |
| E14 | Remove → "Done" / "Add another PC" in step 3 | – | Flow ends with the PC, not with hiding |
| E15 | Secondary: aside "Your codes" (cards) | columns unchanged; "Created by" only in table view | Owner: list stays, secondary |
| E16 | compact | "No codes yet." one line | Not the big centred state |
| E17 | unchanged | – | Major action, step-up stays |
| PC prerequisites (admin account, Windows 10 22H2+ x64, internet) | (i) "What the PC needs" | – | Owner: no prerequisite list up front |

### 2.2 Networks page

| Item | Place | Reason |
|---|---|---|
| N1 | Up: lead "Wi-Fi, printers and drivers your PCs set up by themselves." | Correct and short |
| N2 | One header primary **"Add Wi-Fi network"**; each section has a small ghost "Add" in its head | One main action per screen |
| N3 | Up (unchanged) | – |
| N4 | Record card: name; sub "SSID · WPA2/WPA3" only when SSID ≠ name; status pill (Password set / **Needs password** warning / Open); 2 group chips + "+N"; whole card links; no separate Edit button | Scan-able, less text |
| N5 | Record card: name; sub "Network printer · 10.0.0.20" (host only, no port/queue/driver); "Default" pill; chips | Driver/port are technical → detail page |
| N6 | Record card: name; sub "Printer driver" (class) ; "Provides" removed from card | Technical → detail |
| N5/N6 leads | (i) next to section title | Trim helper text |
| N7 | Compact empty: one dashed row, icon + "No printers yet." + "Add printer" ghost | Owner: compact |
| N8 | Moved into Drivers section → Adv "Printer driver names"; plus inline "Another driver…" in the printer form | Rare; automate |

### 2.3 Wi-Fi form

| Item | Place | Plain label | Automation |
|---|---|---|---|
| W2 | Up, first | "Wi-Fi name" (i: "Exactly as phones show it, capitals included") | byte counter only when > 24 bytes or over |
| **Password** | **Up, second (new)** | "Wi-Fi password" (PasswordInput, show/hide) | Sent with the same submit (§4.3); hint only on error |
| open network | Up, checkbox under password | "This network has no password" | Sets `security: "open"`, hides the password field |
| W1 | Adv, **Auto** | "Name in Rulebox" | Defaults to the SSID (trimmed, ≤ 60; fallback "Wi-Fi network"); editing the SSID keeps following until the name is edited by hand |
| W3 | Adv, default WPA2/WPA3 | "Security type" (Select + InfoTip) | Open is not here (it is the checkbox) |
| W4 | Adv, default off | "Hidden network" | (i) |
| W5 | Adv, default on | "Join automatically" | (i) |
| W6 | Up | "Which PCs get it?" checklist (preselect when exactly 1 group) | – |
| W7 | Remove | – | Password is in the form |
| W10 | Up in the same form (edit) | "Wi-Fi password: Set on 12 Oct · Change" → inline field | No separate card/modal |
| W11 | aside (edit), unchanged labels | – | – |
| W12–W14 | unchanged | – | – |

### 2.4 Printer form

| Item | Place | Plain label | Automation |
|---|---|---|---|
| P3 | Up, first | "Printer address" placeholder "10.0.0.20 or \\\\server\\printer" | **`parsePrinterAddress`** detects kind: `\\host\q` → share; `ipp://`/`https://` → ipp; `http://h:631/…` → `ipp://h:631/…`; `lpr://h/q` → lpr+queue; `h:9100` (or any `h:port` ≠ 631) → raw+port; bare host/IP → ipp `ipp://h/ipp/print`. Live line under the field: "Connects as: Network printer (IPP)" with (i) |
| P1 | Up | "Name on the PCs" placeholder "Front desk printer" | (i) "Shown in the Print window as … (Rulebox)" |
| P7 | Up | "Which PCs get it?" (preselect when 1 group) | – |
| P8 | Up, one switch | "Make it the default printer" (= all picked groups) | Per-group checklist under Adv when > 1 group |
| P2 | Adv | "Connection type" (Select) | Overrides detection; sets the address shape |
| P4/P5 | Adv | "Port" / "Queue name" | Filled by detection; LPR queue error is shown inline even when Advanced is closed (disclosure auto-opens on error) |
| P6 | Adv, **Auto** | "Driver" (SearchSelect) default "Automatic" = IPP class driver for ipp, PCL6 class driver for raw/lpr/share | Last option "Another driver already on the PCs…" → inline name field; on save: `setApprovedPrinterDrivers([...added, name])` then `savePrinter` |

### 2.5 Driver form

| Item | Place | Plain label | Automation |
|---|---|---|---|
| D1 | (i) on the title | – | Trimmed |
| D5 | Up, first | "Download link" | `kindFromUrl` (.zip→inf, .msi→msi, .exe→exe), `nameFromUrl` fills the name |
| check | Up, second | **"Check the file"** button group: "Pick the same file on this computer" (local, nothing uploaded) and "Detect from the link" (`apps:inspectInstaller`, exe/msi only) | Local check (`checkLocalFile`) fills SHA-256, size, kind, silent args, success codes; for a zip, `zipInspect` lists .inf files and reads model names |
| D2 | Up | "Name" | from URL/file name, editable |
| D8 | Up only for a zip with > 1 .inf (Select of found paths); 1 found → Auto; 0 → error "No .inf in this zip" | "Driver file" | – |
| D11 | Up only when names were found: "This driver adds:" chips (ticked) | – | From the INF `[Models]` strings; manual list under Adv |
| D12 | Up | "Which PCs get it?" | – |
| D6 | Adv (shown as "Fingerprint checked ✓" (i) when filled) | "SHA-256" | Manual paste stays possible |
| D7 | Adv, Auto | "File size" | From check; never asked |
| D9/D10 | Adv, Auto | "Silent switches", "Success codes" | From detection; if an .exe has none detected, Adv opens with the required error |
| D3 | Adv, default Printer | "Device type" | (i) USB rules note |
| D4 | Adv | "File type" | Auto from link/file |
| D13 | unchanged | – | – |

---

## 3. Enrollment wizard

### 3.1 Steps

1. **Create a code** — group (default), "How many PCs?" (1), Advanced (code works for, name of the code). One primary
   button **"Create code"**. With defaults this is one click.
2. **Install Rulebox on the PC** — the code (blocks, `translate="no"`), **Copy code** (primary), **Download Rulebox**
   (link), **QR code** (secondary), "Works for 1 PC until …". Three lines: "1. On the new PC, open this page or the
   download link. 2. Run the installer. 3. Paste the code when Rulebox Setup asks." (i) "What the PC needs".
   Advanced "Install without clicks (for IT)": copy `msiexec /i Rulebox-<v>-x64.msi /qn ENROLLCODE=<code>` and the
   `rulebox-agent enroll <code>` line, with the warning "Don't add /l*v: the log would contain the code. PowerShell
   keeps a history: prefer cmd." Below: live status "Waiting for the PC…" (pulse dot, opacity only).
3. **Done** — appears by itself when the first PC joins; the stepper marks 3 as current. Per PC a row: name, "Joined
   2 min ago", stage chips **Joined → Online → Setting up → Ready** (or "Needs attention" → device page). For uses > 1:
   "2 of 5 PCs joined" bar, code still shown above (while in memory) so the next PC can use it. Actions: **"Open PC"**
   per row, **"Add another PC"** (back to step 1, same defaults), **"Done"** (closes the wizard to its idle card).

Idle card (wizard closed): "Add a PC" hero with one button "Add a PC" (admin) — the page opens straight into step 1
when the org has no PCs yet (`orgStats.deviceCount === 0` via `usePlan().usage.devices`).

### 3.2 States

| State | Shown |
|---|---|
| Viewer | Idle card text "An Admin or Owner can add PCs." No button. Codes aside read-only |
| No groups | Step 1 replaced by inline "Name your first group" (default "My PCs") + Create → then step 1 |
| Plan code limit | Inline error under Create + link "See your codes" (focuses aside); no dialog |
| Plan device limit full (`usage.devices >= limits.maxDevices`) | Warning above Create: "Your plan is full: a new PC can't join. Remove a PC or upgrade." Create still allowed (server allows the code) |
| Waiting | pulse + "This page updates by itself." |
| Code expired (client clock, `displayState`) while waiting | Step 2 shows "This code expired." + **"Create a new code"** (same settings); progress keeps any PCs that joined |
| Code revoked (by another admin) | same, "This code was revoked." |
| Code used up | Step 3 "All n PCs joined." |
| Several PCs | List ≤ 10 newest; "and n more on the Devices page" link |
| Wizard closed, reopened (same page) | Code is gone (shown once, plan 4.7). Reopen from the aside: an active code's card has **"See progress"** → step 2/3 without the code: "The code is hidden now. If the PC still needs it, create a new code." |
| Reload / shared link | URL `?watch=<tokenId>` (replace history; the row id, never the code) resumes the progress view the same way |
| tokenId of another org / deleted | `not_found` → "This code isn't available." and `?watch` is dropped |
| Network error | `RegionError` with Try again inside the progress panel only |

### 3.3 Live progress data path

What the backend writes when a PC enrolls (`convex/enrollment.ts:enroll`): patches `enrollmentTokens.usesLeft`,
inserts `devices` (`enrollmentTokenId`, `name`, `enrolledAt`, `groupId`), `devicePresence` (online), `deviceSummary`
(agentVersion, compat → `kioskPhase` later), audit `device.enrolled`. So:

- **New index** `devices.by_enrollment_token: ["enrollmentTokenId"]` (creation order follows).
- **New query** `enrollmentCodes:progress({ tokenId })` (viewer): `getInOrg` token (1) → group name (1) → org row for the
  download (1) → `devices.by_enrollment_token.eq(tokenId).order("desc").take(10)` → per device `devicePresence.by_device`
  (1) + `deviceSummary.by_device` (1). Returns
  `{ label?, groupName?, usesTotal, usesLeft, expiresAt, revoked, joined: number, pcs: { _id, name, enrolledAt, online, kioskPhase? }[], download: { version, url, sizeBytes } | null }`.
  No `nowMs` argument: the client derives expired/active with `displayState` + `useNow(30_000)`, so the query never
  re-runs on the clock.
- **Re-runs** only when: the token row changes (each enrollment, revoke), one of ≤ 10 device/presence/summary rows
  changes (online transition, kiosk phase), the org row changes (rare). Never on pings (liveness is a separate table).
- **Subscribed only** while the wizard shows step 2 or 3 (the component that calls the hook is mounted only then; the
  hook takes `tokenId | null`, `null` = `"skip"`). Idle card, step 1 and other pages: nothing.
- `enrollmentCodes:create` additionally returns `tokenId` (`storeCode` returns `{ expiresAt, tokenId }`); additive.

### 3.4 QR, download, copy

- **Copy**: existing `CopyField` (clipboard API, fallback select + "Press Ctrl+C"). Copies the exact code.
- **Download**: `download.url` from the org's Rulebox release (Settings → Updates; one MSI for every org, PRD 9.1).
  None set → link to the GitHub "latest release" page (`RULEBOX_RELEASES_URL` constant in `src/lib/links.ts`, a plain
  link, no fetch). A second ghost action **"Copy download link"** for sending it to the PC.
- **QR**: on click, a small dialog renders the **code only** (no URL, nothing else) as an SVG, generated in the
  browser by a lazily imported encoder (`src/lib/qr.ts` wrapping `qrcode-generator`, MIT, bundled; offline). Nothing
  exists in the repo today (checked). Use: phones/tablets, and the Android QR provisioning of PRD 18.3 later. Error
  level M; the ~80-character code fits version 6. The SVG is built from the module matrix (rects), `aria-label` "QR code
  of the enrollment code"; closing the dialog unmounts it (code not kept).

### 3.5 Codes list placement

Aside "Your codes" (`ServerTable` with the Cards view from `lists-and-cards.md`; in the aside the view is forced to
cards). Card: label (title), state pill, "1 of 1 used", "expires in 5 h"; actions: "See progress" (active or with
joined PCs), Revoke (admin). Page size 10, newest first; sort control stays (Select). Phone/tablet: under the wizard.

---

## 4. Networks

### 4.1 Page grid

`dash-page` → header → `.net-grid` (in `screens/networks/networks.css`, imported by `Networks.tsx`):

| Band | Layout |
|---|---|
| phone < 600 | 1 column: Wi-Fi, Printers, Drivers (Drivers card collapsed to its head row + count + Add when empty) |
| tablet 600–1023 | 2 columns: Wi-Fi \| Printers; Drivers full width below, compact (records in a 2-col card grid) |
| laptop 1024–1599 | 2 columns: Wi-Fi (left, spans 2 rows) \| Printers (right, row 1), Drivers (right, row 2, compact) |
| wide ≥ 1600 | 3 columns 1fr 1fr 0.8fr: Wi-Fi \| Printers \| Drivers |

Each section is a `Card` with a head: Solar icon, title, count badge, (i), small ghost "Add" (admin). Body = a list of
record cards (container query: 1 column; 2 columns when the section is ≥ 640 px wide). Drivers section title has (i)
"Most setups don't need this. Use it when a printer or scanner needs its maker's driver." and its Advanced holds
"Printer driver names" (the old ApprovedDrivers card, unchanged behaviour).

### 4.2 Record cards and compact empty states

- Card = `<a>` block (whole card clickable, focus ring), 12 px radius, 12/14 px padding: line 1 name (truncate, full
  in `title`) + status pill right; line 2 muted sub; line 3 chips (max 2 groups + "+N", "Not on any PCs yet" muted).
- Wi-Fi pills: "Password set" (success, dot), **"Needs password"** (warning), "Open" (neutral).
- Printers: "Default" pill when `defaultGroupCount > 0`.
- Drivers: class as sub ("Printer driver", "Scanner driver", "Device driver").
- Empty: `.net-empty` one row, dashed border, icon 20 px, text, ghost Add. Viewer: text only.

### 4.3 Wi-Fi add/edit with the password

**Today's storage path (unchanged):** `wifi:setPassphrase` (action, admin) → `wifi:target` (profile + active sealing
key, wrapped) → `checkPassphrase` → rate limit `wifiPassphrase` (30/h/org) → `openWrappedRow` → `encryptAtRest`
(XChaCha20-Poly1305 under the org sealing key, AAD `orgId|profileId|revision`) → `wifi:storePassphrase` (CAS on
revision, `passphrase`, `passphraseRev`, `passphraseSetAt`, revision+1, audit, `snapshotGroupsBatched`) → publisher
schedules `seal:forDevices` (per-device boxes). The plaintext never touches the database, logs, audit or a return value.

**Problem with "create then set" from the client:** `saveWifi` create snapshots every group immediately with
`hasPassphrase: false` (PCs report "Waiting for the password"), then `setPassphrase` snapshots them again: two
configuration versions and two publishes per group (~2× the I/O in `ioBudgets` rows), and a failed second call leaves
a secured network on PCs without a password.

**Plan: one action `wifi:createWithPassphrase`** (admin) `{ name, ssid, hidden, security (not open), autoConnect,
groupIds, passphrase } → { id, revision }`:
1. Pure checks first, no I/O: `checkWifiName`, `checkSsid`, `checkPassphrase`, groups ≤ 100.
2. `wifi:prepareCreate` (internal query): active sealing key present, profile count < 50, groups exist in the org →
   else `not_ready` (sealing_key) / `too_large` / `not_found`. Then `consumeOrFail("wifiPassphrase")`. Nothing written yet.
3. `wifi:insertDraft` (internal mutation): insert profile with **no groups**, revision 1, audit `wifi.created`. No snapshot
   (no groups).
4. `encryptAtRest(..., { profileId: id, revision: 2 })`.
5. `wifi:finishCreate` (internal mutation): CAS revision 1, set `passphrase`, `passphraseRev: 2`, `passphraseSetAt`,
   `groupIds`, revision 2, audit `wifi.passphraseSet`, **one** `snapshotGroupsBatched` (PCs get the network with its
   password in one version).
6. If 4 or 5 throws: `wifi:discardDraft` (internal mutation: delete only if revision 1, no groups, no passphrase; audit
   `wifi.deleted` "removed because its password could not be saved"), then rethrow the original error. If the cleanup
   itself fails, the leftover profile has no groups and no password: on no PC, shown as "Needs password · Not on any
   PCs yet", deletable.

Client (`WifiEdit` new): open network → `saveWifi` (unchanged); secured → `useCreateWifiWithPassphrase`. Errors map to
fields as today (`passphrase` field gets `passphraseServerRefused`). The typed password lives only in form state; after
success the page navigates to the detail (form unmounted, password gone).

**Edit:** the password row sits in the same form: "Wi-Fi password · Set on 12 Oct · **Change**" → inline
`PasswordInput` (empty = keep). Submit: `saveWifi` only if profile fields changed, then `setPassphrase` with the
returned revision if a password was typed. If the second call fails: toast "Network saved", the password field keeps
the typed text with the inline error and "Try again" (sends with the fresh revision). Switching to "no password"
shows the existing behaviour (stored password dropped) with an inline note. `PassphraseDialog.tsx` is deleted.

### 4.4 Printer form

Order: address (with detection line) → name → which PCs → default switch → Advanced (connection type, port, queue,
driver, per-group defaults). Pure helpers in `lib/printerRules.ts`: `parsePrinterAddress(text) → { kind, address,
port?, queue? } | null` and `defaultDriverFor(kind)`. The detected values are what `inputOf` sends; once the user
changes "Connection type" in Advanced, detection stops (manual mode). "Another driver…" adds the name to the approved
list first (one extra mutation, 5 reads / 2 writes) and refuses names that `addedNameProblem` rejects inline.

### 4.5 Driver form

Order: download link → "Check the file" (two buttons) → result summary ("Driver package · 3 printer models · 14 MB ·
fingerprint checked") → name → which PCs → (zip with several .inf: driver file Select) → "This driver adds" chips →
Advanced (type, file type, SHA-256, size, INF path, silent switches, success codes, names list). New lazy chunk
`lib/drivers/zipInspect.ts`: reads the zip's end-of-central-directory and central directory from the `File` (slices,
no full read), lists entries; `.inf` entries ≤ 1 MiB are inflated with `DecompressionStream("deflate-raw")` (stored
entries read directly); `lib/drivers/infModels.ts` parses `[Manufacturer]` → models sections, resolves `%token%` from
`[Strings]`, returns ≤ 10 unique model names (≤ 100 chars). Hash/size/kind/args reuse `lib/apps/localInstaller.ts`
`checkLocalFile`. Failure of any check never blocks: the manual fields under Advanced stay available.

---

## 5. Layout per band and wireframes

### 5.1 Enrollment

| Band | Layout |
|---|---|
| 390 | Wizard full width, vertical stepper (numbers left), Copy code sticky at the bottom in step 2; codes below as cards |
| 820 | Wizard full width, horizontal stepper; step 2 code + actions in 2 columns (code left, actions right); codes below, 2-col cards |
| 1366 | `dash-split`: wizard (2/3) + aside "Your codes" (1/3, cards) |
| 1920 | same, content max 1480 px; step 3 PC rows in a 2-col grid |

Laptop (1366), step 2 waiting:
```
 Add a PC                                                       
 Three steps. The new PC shows up here by itself.              
┌──────────────────────────────────────────────┐ ┌───────────────────────┐
│ (1)✓ Create code ── (2) Install on the PC ── (3) Done │ │ Your codes      Sort ▾│
│                                              │ │┌─────────────────────┐│
│  Your code (shown once)              (i)     │ ││Front desk · 28 Nov  ││
│  ┌──────────────────────────────────────┐    │ ││● Active  0 of 1 used││
│  │ RBX1. aHR0 cHM6 Ly9n YWxs … (blocks)  │    │ ││expires in 23 h      ││
│  └──────────────────────────────────────┘    │ ││See progress  Revoke ││
│  [⧉ Copy code]  [↓ Download Rulebox]  [▦ QR] │ │└─────────────────────┘│
│  Works for 1 PC until tomorrow 14:05         │ │┌─────────────────────┐│
│  1. On the new PC, open this page or the link│ ││Office · 20 Nov      ││
│  2. Run the installer.                       │ ││○ Used up 3 of 3     ││
│  3. Paste the code when Rulebox Setup asks.  │ │└─────────────────────┘│
│  (i) What the PC needs                       │ │ ‹ Prev  Page 1  Next ›│
│  ▸ Advanced: install without clicks (for IT) │ └───────────────────────┘
│ ┌──────────────────────────────────────────┐ │
│ │ ◌ Waiting for the PC…                     │ │
│ │   This page updates by itself.            │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```
Phone (390), step 3:
```
 Add a PC
┌────────────────────────────┐
│ ① Create code          ✓  │
│ ② Install on the PC    ✓  │
│ ③ Done                 ●  │
│ ┌────────────────────────┐ │
│ │ FRONT-DESK-01          │ │
│ │ Joined 2 min ago       │ │
│ │ ✓Joined ✓Online ◌Setting│ │
│ │ [Open PC]              │ │
│ └────────────────────────┘ │
│ 1 of 1 PC joined           │
│ [Add another PC]  [Done]   │
└────────────────────────────┘
 Your codes
┌────────────────────────────┐
│ Front desk · 28 Nov ● Used │
└────────────────────────────┘
```

### 5.2 Networks

Laptop (1366):
```
 Networks                                          [+ Add Wi-Fi network]
 Wi-Fi, printers and drivers your PCs set up by themselves.
┌──────────────────────────────┐ ┌──────────────────────────────┐
│ ⌔ Wi-Fi  3 (i)        + Add │ │ ⎙ Printers  0 (i)     + Add  │
│┌────────────┐┌────────────┐ │ │┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐│
││Shop floor  ││Back office │ │ │  ⎙ No printers yet. [Add]   │
││●Password set││▲Needs pass.│ │ │└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘│
││[Tills] +1  ││Not on PCs  │ │ └──────────────────────────────┘
│└────────────┘└────────────┘ │ ┌──────────────────────────────┐
│┌────────────┐               │ │ ▣ Drivers  0 (i)      + Add  │
││Guest  Open │               │ │  No drivers. Most setups      │
│└────────────┘               │ │  don't need one.              │
└──────────────────────────────┘ │ ▸ Advanced: printer driver   │
                                  │   names                      │
                                  └──────────────────────────────┘
```
Phone (390): one column, same cards one per row; Drivers card shows only its head row when empty.

### 5.3 Wi-Fi form (new)

| Band | Layout |
|---|---|
| 390 | one column; "Add network" sticky bottom |
| 820 | one column, max 640 px |
| 1366/1920 | `dash-split`: form (2/3) + aside "How it works" (3 short lines: PCs join before sign-in; password encrypted; changes reach PCs within a minute). Edit page: aside = counts, remove, history |

Laptop:
```
 ← All networks
 New Wi-Fi network
┌───────────────────────────────────────────┐ ┌──────────────────────┐
│ Wi-Fi name (i)                            │ │ How it works          │
│ [ Shop floor                       ]      │ │ • PCs join before     │
│ Wi-Fi password                            │ │   anyone signs in.    │
│ [ •••••••••••              👁 ]           │ │ • The password is     │
│ ☐ This network has no password            │ │   encrypted; nobody   │
│ Which PCs get it?                         │ │   can read it back.   │
│ ☑ Tills   ☐ Office   ☐ Kiosk              │ │                       │
│ ▸ Advanced (name in Rulebox, security,    │ └──────────────────────┘
│   hidden network, join automatically)     │
│ [ Add network ]  Cancel                   │
└───────────────────────────────────────────┘
```
Phone: same fields stacked, aside dropped (its lines move into the (i) of the title).

---

## 6. Data

| Function | Kind | Reads / run | Writes | Live | ioBudgets row |
|---|---|---|---|---|---|
| `enrollmentCodes:progress` (new) | query, viewer | wrapper 3 + token 1 + group 1 + org 1 + devices ≤ 10 + presence ≤ 10 + summary ≤ 10 = **36** | 0 | yes, step 2/3 only | `{ maxReads: 36, maxReadBytes: 40_000, maxWrites: 0, maxWriteBytes: 0, live: true }` |
| `enrollmentCodes:create` | action (changed return) | unchanged | unchanged | – | unchanged |
| `wifi:createWithPassphrase` (new) | action, admin | 4 + prepareCreate (1 key + 50 profiles + 100 groups) + insertDraft (50 + 0) + finishCreate (1 + 100 + 10·921 + 200 + 1) | insert 1 + audit 1 + patch 1 + audit 1 + 10·13 + 3 | – | sum of the internal rows, like `wifi:setPassphrase` |
| `wifi:prepareCreate` (internal query) | | 151 | 0 | | `{ 151, 40_000, 0, 0 }` |
| `wifi:insertDraft` (internal) | | 50 | 2 | | `{ 50, 30_000, 2, 2_048 }` |
| `wifi:finishCreate` (internal) | | 1 + 100 + (10·921 + 200) + 1 | 2 + 10·13 + 3 | | as `wifi:storePassphrase` + 100 group reads |
| `wifi:discardDraft` (internal) | | 1 | 2 | | `{ 1, 2_048, 2, 1_024 }` |
| `networks:list`, `saveWifi`, `setPassphrase`, `savePrinter`, `setApprovedPrinterDrivers`, `drivers:save`, `apps:inspectInstaller` | unchanged | – | – | – | unchanged |

- **Schema:** `devices.index("by_enrollment_token", ["enrollmentTokenId"])` (the field is required on every row, so no
  backfill question; Convex builds the index on deploy). Write cost: one index entry per enrolled PC.
- **No new subscription** on Networks: the page keeps the one `networks:list`; forms keep theirs.
- **Data seam (enrollment, `data/enrollment/*`):** `useEnrollmentProgress(tokenId: Id | null): QueryState<EnrollmentProgress>`;
  `useCreateEnrollmentCode` resolves `{ code, expiresAt, tokenId }`. Types `EnrollmentProgress`, `EnrollmentPc` in
  `data/types.ts`. Live: `useQuery(api.enrollmentCodes.progress, tokenId ? { tokenId } : "skip")` through the usual
  `QueryState` mapper. **Demo:** create stores the token; a demo-only timer per created token simulates a PC: +6 s
  device row "DEMO-PC-0n" (usesLeft −1), +8 s online, +10 s kiosk `applying`, +14 s `applied` (cleared on revoke and on
  store reset; tests use fake timers). Demo `download` = `{ version: "0.1.0", url: "https://example.invalid/Rulebox-0.1.0-x64.msi", sizeBytes: 31_000_000 }`.
- **Data seam (main, `data/api.ts`):** `useCreateWifiWithPassphrase: Mutation<WifiInput & { passphrase: string }, { id: Id; revision: number }>`
  live (`useAction` + `useMapped`) and demo (same checks as demo `saveWifi` + `setPassphrase`, one store change).

---

## 7. Strings (plain labels; (i) texts ≤ 3 short sentences)

`screens/enrollment/strings.ts` (replaces the dialog strings; list strings stay):
- title "Add a PC"; lead "Three steps. The new PC shows up here by itself."
- steps: "Create a code", "Install on the PC", "Done"
- group "Joins the group"; info "Settings, apps and Wi-Fi of this group reach the PC as soon as it joins."
- uses "How many PCs?"; info "One code can set up several PCs. It stops working after that many."
- advanced "More options"; expiry "Code works for"; label "Name of the code"; labelInfo "Only for you, in the list of codes."
- create "Create code"; firstGroup "Your PCs need a group first."; firstGroupName "Group name"; firstGroupCreate "Create group"
- codeTitle "Your code"; codeOnceInfo "Shown only now. Copy it before you leave this page. If it gets lost, revoke it and make a new one."
- copy "Copy code"; download "Download Rulebox"; copyLink "Copy download link"; qr "QR code"; qrTitle "Scan the code"
- worksFor(n, when) "Works for 1 PC until tomorrow 14:05." / "Works for 5 PCs until …"
- how1 "On the new PC, open this page or the download link."; how2 "Run the installer."; how3 "Paste the code when Rulebox Setup asks."
- needsInfo label "What the PC needs"; text "Windows 10 22H2 or 11, 64-bit, an administrator account and internet. Setup checks the rest."
- silentTitle "Install without clicks (for IT)"; silentWarn "Don't add /l*v: the log would contain the code. Use Command Prompt; PowerShell keeps a history."
- waiting "Waiting for the PC…"; waitingSub "This page updates by itself."
- stages: "Joined", "Online", "Setting up", "Ready", "Needs attention"
- joinedOf(n, m) "2 of 5 PCs joined"; allJoined "All PCs joined."; morePcs(n) "and n more on the Devices page"
- openPc "Open PC"; another "Add another PC"; done "Done"
- expired "This code expired."; revokedNow "This code was revoked."; newCode "Create a new code"
- hiddenNow "The code is hidden now. If the PC still needs it, create a new code."; gone "This code isn't available."
- planFull "Your plan is full: a new PC can't join. Remove a PC or upgrade."; seeCodes "See your codes"
- aside "Your codes"; seeProgress "See progress"; viewerIdle "An Admin or Owner can add PCs."

`screens/networks/strings.ts` (changed/new):
- lead "Wi-Fi, printers and drivers your PCs set up by themselves."; add "Add"; addWifi "Add Wi-Fi network"
- wifiInfo "PCs join these networks on their own, before anyone signs in."; printersInfo "PCs add these printers by themselves; they appear in every Print window."; driversInfo "Most setups don't need this. Use it when a printer or scanner needs its maker's driver."
- pills "Password set", "Needs password", "Open", "Default"; notOnPcs "Not on any PCs yet"
- empties "No Wi-Fi networks yet.", "No printers yet.", "No drivers."
- ssid "Wi-Fi name"; ssidInfo "Exactly as phones show it, capital letters included."
- password "Wi-Fi password"; passwordInfo "Stored encrypted. Each PC gets it in a form only that PC can read. Nobody can read it back."
- openNetwork "This network has no password"; change "Change"; keepEmpty "Leave empty to keep the current password."
- nameInRulebox "Name in Rulebox"; securityType "Security type"; whichPcs "Which PCs get it?"
- savedNoPassword "Network saved. The password wasn't saved: try again."
- printerAddress "Printer address"; addressInfo "The printer's IP address or name, a full ipp:// address, or \\\\server\\printer for a shared one."
- connectsAs(kind) "Connects as: Network printer (IPP)"; nameOnPcs "Name on the PCs"; makeDefault "Make it the default printer"
- connectionType "Connection type"; driverAuto "Automatic (built into Windows)"; otherDriver "Another driver already on the PCs…"
- downloadLink "Download link"; checkFile "Pick the same file on this computer"; checkFileInfo "Rulebox reads it here to fingerprint it. Nothing is uploaded."; detectLink "Detect from the link"
- checkSummary(kind, models, size) "Driver package · 3 printer models · 14 MB · fingerprint checked"; noInf "No .inf file in this zip."
- adds "This driver adds"; deviceType "Device type"; fileType "File type"; silentSwitches "Silent switches"; successCodes "Success codes"

Removed: `noPassphraseInForm`, `passphraseCard*`, `passphraseTitle*`, `passphraseLead`, `created` ("Now set its password"),
`codeDone`, `createTitle`, `custom*`, `units`, `kindLabel`, long `*Hint` texts moved to `info`.

---

## 8. Edge cases and roles

- **Roles:** viewer = read-only everywhere (idle card text, aside without Revoke, networks cards without Add, forms
  replaced by the read-only views); admin/owner = everything; revoke keeps the fresh step-up.
- Code text never in URL, storage, toast, console or audit (unchanged); `?watch` holds the row id only. QR dialog
  unmounts with the code. The localStorage "last group" holds a group id only.
- Wizard: create double-click (button disabled while pending); group deleted between load and create (`not_found`
  sentence, picker refreshes); 100-use code shows ≤ 10 PCs; two admins watching the same code see the same list;
  a PC that enrolled with an old pre-Step-6 token (no `usesTotal`) → total = `usesLeft + joined`.
- Kiosk failed (`kioskPhase: "failed"`) → "Needs attention" link to `/devices/:id`; PC offline right after join →
  stays at "Joined" with "Not online yet" muted.
- Reduced motion / Lite mode: pulse dot static; stepper and step changes use `dash-enter` (opacity/transform) only.
- Wi-Fi: SSID with leading/trailing spaces (kept exactly; name default trimmed); SSID > 32 bytes (counter turns red,
  inline); passphrase 64 hex accepted; switching secured→open on edit warns inline "The saved password will be
  deleted."; profile limit 50 (`too_large` sentence); no sealing key (`not_ready` sentence, nothing created);
  rate limited (`rate_limited`, nothing created); stale edit (Reload offer, typed password kept until reload).
- Printer: address that parses to nothing (inline "Enter an IP address, a name, an ipp:// address or \\\\server\\printer");
  IPv6 bare host → `ipp://[v6]/ipp/print`; host > 48 chars for raw/LPR → inline; default taken (`defaultTaken` sentence);
  driver no longer approved (kept and marked, as today).
- Driver: huge file (hashing in 4 MiB chunks with a progress line; Cancel); zip without central directory / zip64 / encrypted
  entries → "Couldn't read this zip" and manual Advanced; file differs from link (the PC refuses it: (i) on the check
  says "Pick the exact file the link downloads"); `inspect_unsupported` host → message, manual fields.
- Networks: 50 Wi-Fi + 100 printers on one page (cards virtualisation not needed: ≤ 200 small rows; sections scroll
  with the page, not inside).

---

## 9. Tests

Existing tests that change:
- `apps/dashboard/src/screens/step6.test.tsx`: "Create a code" block rewritten for the wizard (one-click create with
  defaults; group preselection rules; stepper 1–100; Advanced presets 15 min/1 h/1 day/7 days; auto label sent; custom
  lifetime tests removed); "the code is shown once" adapted (Copy, Download, QR; leaving drops it); errors still
  inline; revoke unchanged; list tests adapted to the aside + cards (selectors by role/text).
- `apps/dashboard/src/screens/lists4b.test.tsx`: Enrollment list assertions (cards in the aside).
- `apps/dashboard/src/screens/step13.test.tsx`: "has no password field" → "has the password field"; creation calls
  `createWifiWithPassphrase` once with the password and no `saveWifi`; open network calls `saveWifi`; name defaults
  from SSID; Advanced fields; edit: inline Change, two calls, second failure keeps the typed text; dialog tests move to
  the inline field; list tests for cards/pills/compact empty.
- `apps/dashboard/src/screens/step14.test.tsx`: printer form detection, default switch, driver Automatic, "Another
  driver…" (two calls in order), Networks printer cards.
- `apps/dashboard/src/screens/step14b.test.tsx`: driver form (link → kind/name; local check fills fields; Advanced),
  ApprovedDrivers inside the Drivers section's Advanced.
- `apps/dashboard/src/lib/printerRules.test.ts`: `parsePrinterAddress` vectors (share, ipp, https, http:631, lpr://,
  host:9100, host:631, bare IPv4/IPv6/name, junk), `defaultDriverFor`.
- `apps/dashboard/src/lib/wifiRules.test.ts`: `defaultWifiName(ssid)` (trim, ≤ 60, empty → fallback).
- `convex/enrollmentCodes.test.ts`: `create` returns `tokenId`; new `progress` tests (other org `not_found`; 0/1/12 PCs →
  ≤ 10 newest + `joined` 12; presence/summary mapped; revoked/expired fields; no `nowMs`).
- `convex/networks.test.ts`: `createWithPassphrase` happy path (one group config version per group, `hasPassphrase`
  true in it, passphrase never in any query result); invalid passphrase / no sealing key / rate limited / 50 profiles →
  nothing inserted; failure in finish → draft deleted + audit; `discardDraft` refuses a profile that has groups.
- `convex/ioBudgets.test.ts` via `tests/convex/matrixRows.ts` (new public rows) and `tests/convex/ioInternal.ts`
  (new internal rows).
- `apps/dashboard/src/data/demo/demo.test.tsx`: demo create returns `tokenId`; simulated PC timeline with fake timers.

New tests:
- `screens/enrollment/wizard.test.tsx`: steps, waiting → step 3 on progress, several PCs, expired/revoked, `?watch`
  resume without the code, viewer, no groups quick create, plan full warning, `progress` hook gets `null` (skip) on
  step 1 and idle.
- `screens/enrollment/model.test.ts`: `autoLabel`, `pickDefaultGroup`, `silentCommand`.
- `lib/qr.test.ts`: matrix size for an 80-char code, SVG has `aria-label`, deterministic output.
- `lib/drivers/zipInspect.test.ts` (zips built in the test, stored + deflate entries, nested paths, no .inf, zip64 refusal)
  and `lib/drivers/infModels.test.ts` (Strings resolution, decorated sections `NTamd64`, dedupe, cap 10).
- `lib/driverRules.test.ts` additions: `kindFromUrl`, `nameFromUrl`.
- `e2e/shots.mjs` paths: `enrollment:/enrollment`, `networks:/networks`, `wifi-new:/networks/wifi/new`,
  `printer-new:/networks/printers/new`, `driver-new:/networks/drivers/new`.

---

## 10. Build steps (one Sonnet agent each; ∥ = can run in parallel)

Prerequisite: the foundations (Select, SearchSelect, InfoTip, Field `info`, layout classes, `dash-advanced`, Cards
view with a forced-cards option) are merged.

0. **Main session only:** `pnpm --filter @rulebox/dashboard add qrcode-generator@<exact, ≥ 2 weeks old>`; add the MIT
   credit to `THIRD_PARTY_NOTICES.md`. (Agents must not run `pnpm install`.)
1. ∥ **Convex enrollment** — `convex/schema.ts` (index), `convex/enrollmentCodes.ts` (`storeCode` returns tokenId,
   `create` returns it, new `progress`), `convex/ioBudgets.ts`, `tests/convex/matrixRows.ts`,
   `convex/enrollmentCodes.test.ts`. Verify `pnpm test:convex`.
2. ∥ **Convex Wi-Fi create** — `convex/wifi.ts` (`createWithPassphrase`, `prepareCreate`, `insertDraft`,
   `finishCreate`, `discardDraft`), comment block in `convex/networks.ts` CONTRACT, `convex/ioBudgets.ts` (different
   lines from step 1: run after 1 or merge carefully), `tests/convex/ioInternal.ts`, `convex/networks.test.ts`.
3. ∥ **Pure libs** — `lib/printerRules.ts` (+test), `lib/wifiRules.ts` (+test), `lib/driverRules.ts` (+test),
   `screens/enrollment/model.ts` (+test: autoLabel, pickDefaultGroup, silentCommand; drop custom TTL), `lib/links.ts`.
4. ∥ **Driver file libs** — `lib/drivers/zipInspect.ts`, `lib/drivers/infModels.ts` + tests.
5. **Enrollment seam** (after 1) — `data/types.ts` (EnrollmentProgress, EnrollmentPc), `data/enrollment/{api,live}.ts`,
   `data/demo/hooks.ts` (demoEnrollmentApi + simulated PC), demo tests.
6. **Wi-Fi seam** (after 2 and 5: same `demo/hooks.ts`) — `data/api.ts`, `data/live/*`, `data/demo/hooks.ts`.
7. **QR** (after 0) — `lib/qr.ts` + test, `screens/enrollment/QrDialog.tsx`.
8. **Enrollment screen** (after 3, 5, 7) — `screens/enrollment/{AddPcWizard,CreateStep,InstallStep,ProgressPanel,CodesAside}.tsx`,
   `Enrollment.tsx`, `enrollment/strings.ts`, `enrollment/enrollment.css`, `step6.test.tsx`, `lists4b.test.tsx`,
   `wizard.test.tsx`.
9. ∥ with 8: **Networks page** — `Networks.tsx`, `screens/networks/{RecordCard,SectionCard}.tsx`,
   `screens/networks/networks.css`, `ApprovedDrivers.tsx` (inside Drivers Advanced), `networks/strings.ts` (page part),
   list parts of `step13/14/14b.test.tsx`.
10. **Wi-Fi form** (after 3, 6, 9: strings file) — `WifiEdit.tsx`, delete `PassphraseDialog.tsx`, strings, `step13.test.tsx`.
11. **Printer form** (after 10: strings file) — `PrinterEdit.tsx`, strings, `step14.test.tsx`.
12. **Driver form** (after 4, 11) — `DriverEdit.tsx`, strings, `step14b.test.tsx`.
13. **Main session:** `e2e/shots.mjs` paths, typecheck + lint + `pnpm --filter @rulebox/dashboard test`, `pnpm test:convex`,
    size budget (`scripts/size.mjs`; QR and zip chunks are lazy), screenshots 390/820/1366/1920 light + dark on a
    demo server (port 4346), review, commit.

Steps 9–12 share `networks/strings.ts`: run them in sequence (or split strings per form first, as part of step 9:
`networks/strings.ts` keeps the page, `wifiStrings.ts`, `printerStrings.ts`, `driverStrings.ts` take the forms — then
10, 11, 12 can run ∥). Recommended: do that split in step 9.

---

## 11. Decisions taken (recommended option chosen; owner reviews)

| # | Decision | Options | Taken |
|---|---|---|---|
| 1 | Where the wizard lives | (a) main panel on `/enrollment` (b) modal (c) new route | **(a)** — progress and codes on one page |
| 2 | Page name | (a) "Add a PC" (route stays `/enrollment`, nav label too) (b) keep "Enrollment" | **(a)** plain words; nav label coordinated with foundations |
| 3 | Live progress | (a) new `progress` query + `devices.by_enrollment_token` (b) token row only (count, no names) (c) newest org devices | **(a)** ≤ 36 reads, names + stages, only while watched |
| 4 | Clock in progress query | (a) client `displayState` (b) `nowMs` arg | **(a)** no minute re-runs |
| 5 | Resume after reload | (a) `?watch=<tokenId>` (b) sessionStorage (c) none | **(a)** row id is not secret; shareable |
| 6 | Download source | (a) org release URL, else GitHub latest page link (b) always GitHub (c) none | **(a)**; carried by the progress query (org row), no extra subscription |
| 7 | QR payload | (a) the code only, on demand (b) download link (c) no QR | **(a)**; limited use on Windows v1, ready for PRD 18.3 |
| 8 | QR encoder | (a) `qrcode-generator` (MIT) lazy chunk (b) own encoder | **(a)** proven; added by the main session |
| 9 | Defaults | uses 1 (stepper); expiry 1 day (Advanced; custom dropped); label auto "{group} · {date}" (Advanced); group = last used in this browser → only → first | as listed |
| 10 | No groups | (a) inline quick create (b) link to Groups | **(a)** |
| 11 | Silent install command | (a) Advanced with log/history warning (b) omit | **(a)** |
| 12 | Codes list | (a) aside, cards, laptop+ (b) full width below | **(a)** secondary, no stacked full-width sections |
| 13 | Wi-Fi password at create | (a) new action `wifi:createWithPassphrase` (draft without groups → encrypt → finish + one snapshot; cleanup on failure) (b) client create then set (c) client 3 calls | **(a)** one submit, one publish, no PC sees a password-less profile |
| 14 | Wi-Fi password at edit | (a) inline in the form, two calls (b) keep dialog | **(a)** |
| 15 | Wi-Fi display name | (a) default from SSID, under Advanced (b) keep both up front | **(a)** |
| 16 | Security / hidden / auto-join | (a) Advanced + "no password" checkbox up front (b) up front | **(a)** |
| 17 | Networks grid | wide 3 cols; laptop 2 cols (Wi-Fi \| Printers + Drivers); tablet 2 + 1; phone 1 | as listed; Drivers compact, less prominent |
| 18 | Header actions | (a) one primary "Add Wi-Fi network" + small Add per section (b) three primaries | **(a)** |
| 19 | Approved printer driver names | (a) Drivers section Advanced + inline "Another driver…" in printer form (b) keep card | **(a)** |
| 20 | Printer kind/port/queue/driver | (a) detect from one address field; Advanced overrides; driver auto by kind (b) keep selects | **(a)** |
| 21 | Driver hash/size/args | (a) local file check + link detect, manual under Advanced (b) server downloads and hashes | **(a)** no large server fetch; same trust as today |
| 22 | INF path and provided names | (a) read the zip in the browser (central directory + `DecompressionStream`) (b) manual only | **(a)**, manual fallback |
| 23 | Device class | (a) Advanced, default Printer (b) up front | **(a)** |
| 24 | Plan full (devices) | (a) warn, allow code (b) block create | **(a)** server unchanged |

> PRD: no behaviour change. Wording changes only (page named "Add a PC"; the Wi-Fi password is entered in the add form,
> still only through an action that encrypts it). Tell the owner so PRD 9.1 / 24.2 can mention the dashboard flow.

## Dependencies on other plans

- `foundations.md`: `InfoTip`, `Field info`, `Select`/`SearchSelect`, `dash-split`, `dash-advanced` (must support
  `open` controlled so a field error inside can open it), `dash-enter`.
- `lists-and-cards.md`: `ServerTable` Cards view with a `view="cards"` override for the aside.
- `settings.md`: the release the download link uses is the org release set there; the GitHub repo constant should be
  shared (`src/lib/links.ts`).
