# Dashboard UI pass: audit (2026-11-28)

Every dashboard screen rated against the owner's bar (`docs/plans/follow-ups.md`, "NEXT after VM run A3"): a deliberate
layout at phone, tablet, laptop and wide widths; short text; few options; plain words; technical values hidden or
automated. Companion to `README.md` (rules, width bands, component contract).

## How this audit was done

- Demo server on port 4331, `apps/dashboard/e2e/shots.mjs` plus a small extra script for the public pages, a real
  employee, and the dialogs. Light theme at 390, 820, 1366 and 1920 for the main routes; 390 and 1366 for public
  pages and dialogs. Files: `.tmp/ui-pass/audit/<name>-<width>-light.png` (gitignored). The dark theme was not
  shot: the coordinator limited the run to light.
- **Images actually looked at** (marked "seen" below): overview 390/1366/1920, groups 1366, group 390/1366,
  rollout 1366, employees/new 1366, employee detail 1366, broadcasts 1366, file types 1366, audit 1366, sign-in 1366,
  join 390, 404 1366, dialogs send message 390, rollback 1366, assign app 1366. Pages already planned elsewhere, and
  the 820/1920 shots of the rest, were taken but not inspected: those verdicts come from the code and the plans.
- **Horizontal overflow: none.** The script printed no "[horizontal overflow]" line for any of the 140 route shots,
  nor for the extra public/dialog shots (no `pageerror` either).
- `shots.mjs` bug (not fixed, out of scope): `@employee` resolves to `/employees/new` because the first
  `main a[href^='/employees/']` is the "Add employee" button. For a real employee use a link that is not `/new`.
- The code moved while the audit ran (other agents build the shared components). Line numbers below are as of the
  audit; re-grep before using them.

## (a) Screen table

Verdicts: **in scope** (needs a redesign), **fine** (leave, small polish only), **planned** (another plan owns it,
rated in one line). "Bands" = problems at phone 390 / tablet 820 / laptop 1366 / wide 1920.

### Signed-in routes

| Route | Screen file | Verdict | Why | Problems by band | Shots |
|---|---|---|---|---|---|
| `/` | `Overview.tsx` | **in scope** | Home page; the order is right (stats, attention, activity) but the layout is one fixed recipe and the failed-installs table dominates. | 390 (seen): four full-height stat cards stack, about 1100 px before the first real information; 1366 (seen): good 2:1 grid but the left column is 1700 px tall because "Failed installs" is a full paginated table; 1920 (seen): same 2:1 layout, content capped at 1480, fine; all: attention items are long sentences with jargon ("Lockdown policy not applied", "Program rules still in audit mode") and a vendor word leaks ("Your fleet may exceed the Convex free plan, see Usage in the Convex dashboard"). | `overview-{390,820,1366,1920}-light` |
| `/devices` | `Devices.tsx` | planned: `lists-and-cards.md` | List page. | not inspected | `devices-*` |
| `/devices/:id` | `DeviceDetail.tsx` | planned: `device-detail.md` | Top-priority page. | not inspected | `device-*`, `deviceLong-*` |
| `/groups` | `Groups.tsx` | planned (list): `lists-and-cards.md`; page chrome fine | A table with a search and "New group"; works. | 1366 (seen): the group name column is 700 px wide and empty on the right, numbers far right; the table is the whole page. Cards view is planned. The "New group" dialog is two plain fields: fine. | `groups-*` |
| `/groups/:id` | `GroupDetail.tsx` | **in scope** | The hub of the product, laid out as a stack of five full-width sections. | 1366 (seen): Apps table, "Display and memory" card with three full-width dropdowns, then Devices and Employees side by side (Devices 3 rows next to a 10-row Employees list, a gap of 600 px), then History: five sections, each with its own pager. 390 (seen): the Apps rows show only the app name, so "Who sees it", the pins and the Edit / Unassign buttons are not visible (verify: may be clipped by the stack mode); the header actions wrap to two rows; three pagers in a row. All: "Display and memory" (Lite mode, window caps) is technical and shown to everyone; Delete sits next to Edit. | `group-*`, `groupEmpty-*` |
| `/groups/:id/rollout` | `Rollout.tsx` + `rollout/*` | **in scope** | An advanced feature (rings) as six stacked full-width cards with full-width number inputs. | 1366 (seen): six cards, each 1040 px wide, the two number inputs are 1000 px wide for the value "24" and "60"; "Promote to Early", "Promote all", "Roll back" are plain buttons below a list; the ring names Pilot / Early / Everyone and the words "bake", "promote", "ring", "configuration version" need an explanation. 390: not seen; same stack, the rings list rows will wrap. | `rollout-*` |
| `/groups/:id/lockdown` | `Lockdown.tsx` + `lockdown/*` | planned: `lockdown.md` | 3500 px tall page. | not inspected | `lockdown-*` |
| `/lockdown/findings` | `Findings.tsx` | planned: `lockdown.md` | | not inspected | `findings-*` |
| `/networks` | `Networks.tsx` | planned: `enrollment-networks.md` | | not inspected | `networks-*` |
| `/networks/wifi/new` and `/:id` | `WifiEdit.tsx` | planned: `enrollment-networks.md` | | not inspected | `wifinew-*` |
| `/networks/printers/new` and `/:id` | `PrinterEdit.tsx` | planned: `enrollment-networks.md` | | not inspected | `printernew-*` |
| `/networks/drivers/new` and `/:id` | `DriverEdit.tsx` | planned: `enrollment-networks.md` | | not inspected | `drivernew-*` |
| `/broadcasts` ("Messages") | `Broadcasts.tsx` + `broadcasts/*` | planned (list): `lists-and-cards.md`; compose dialog **in scope** | List is a plain table. The composer is a dialog with three dropdowns and two long hints. | 1366 (seen): the list is fine but the title wraps to a two-line lead next to the button; the page is a table and nothing else (no sense of "what is live now"). Dialog at 390 (seen): bottom sheet, one column, good; helper under "Ask for an acknowledgement" is 3 lines; no preview of what the PC will show although `broadcasts/Preview.tsx` exists. | `broadcasts-*`, `dlg-send-message-*` |
| `/employees` | `Employees.tsx` | planned: `lists-and-cards.md` | | not inspected | `employees-*` |
| `/employees/new` | `EmployeeDetail.tsx` | **in scope** | One 1040 px card with every field full width. | 1366 (seen): Username sits next to Name but "Storage quota (GB)" is alone on a row; Groups and Extra apps are long checkbox lists in a scroll box (the "Extra apps" list is cut mid-row at "Inventory"); First password full width. 390: not seen. Needs a real layout (aside with a summary, pickers instead of long lists). | `employeenew-*` (this is also what `employee-*` shows, see the bug above) |
| `/employees/:id` | `EmployeeDetail.tsx` | **in scope** | Better than "new": profile card plus an aside (Password, Account, History), but the left card is the same long form. | 1366 (seen): 2:1 split is right; aside cards are fine; left card has the same long checkbox lists, the groups list is the whole PC fleet of an organization (hundreds of groups would be unusable); a disabled-state "Account" card in danger colour is loud. | `employeedetail-{390,1366}-light` |
| `/apps` | `Apps.tsx` | planned: `lists-and-cards.md` | | not inspected | `apps-*` |
| `/apps/new?kind=desktop`, `?kind=web` | `AppEdit.tsx` + `AppInstaller/AppUpdates/AppBrowser/AppPermissions.tsx` | planned: `add-app.md` | | not inspected | `appnewdesktop-*`, `appnewweb-*` |
| `/apps/:id` (desktop and web) | `AppEdit.tsx` | planned: `add-app.md` | | not inspected | `app-*`, `appweb-*` |
| `/file-types` | `FileTypes.tsx` | planned (list): `lists-and-cards.md`; add dialog **in scope (small)** | Plain table of ".pdf opens with X". | 1366 (seen): fine as a list, "Remove" in red on every row; the add dialog asks for a raw extension (".pdf") and a program. | `filetypes-*`, `dlg-add-filetype-*` |
| `/enrollment` | `Enrollment.tsx` | planned: `enrollment-networks.md` | | not inspected | `enrollment-*` |
| `/audit` | `Audit.tsx` + `components/AuditItem.tsx` | planned (list): `lists-and-cards.md`; wording **in scope (small)** | A table of 5 columns. | 1366 (seen): fine as a table. Details show internal field names ("Changed: offlineDays, power."), the heading says "Times are shown in Asia/Karachi" (a time-zone ID), "Member" / "System" / "Device" sublabels. No filters (who, what, PC, date). 390: card list expected from the plan. | `audit-*` |
| `/settings?tab=organization` | `settings/OrganizationTab.tsx` | planned: `settings.md` | | not inspected | `set-organization-*` |
| `/settings?tab=adminExit` | `settings/AdminExitTab.tsx` | planned: `settings.md` | | not inspected | `set-adminExit-*` |
| `/settings?tab=signing` | `settings/SigningTab.tsx` | planned: `settings.md` | | not inspected | `set-signing-*` |
| `/settings?tab=updates` | `settings/UpdatesTab.tsx` | planned: `settings.md` | | not inspected | `set-updates-*` |
| `/settings?tab=members` | `settings/MembersTab.tsx` | planned: `settings.md` | | not inspected | `set-members-*` |
| `/settings?tab=security` | `settings/SecurityTab.tsx` | planned: `settings.md` | | not inspected | `set-security-*` |
| `/settings?tab=about` | `settings/AboutTab.tsx` | planned: `settings.md` | | not inspected | `set-about-*` |
| `/gallery` | `Gallery.tsx` | fine | Developer-only component gallery, not a product screen. | not shot | |
| any other path | `NotFound.tsx` | fine | Centred 404 with one button. | 1366 (seen): fine; the shell stays. | `notfound-*` |

### Public and sign-in-adjacent routes

| Route | Screen file | Verdict | Why | Problems by band | Shots |
|---|---|---|---|---|---|
| `/sign-in` | `SignIn.tsx` in `AuthShell` | fine | Split layout: brand panel with three promises on the left, form on the right. | 1366 (seen): good. 390: shell collapses to a header strip plus the form (seen on `/join`): good. Small: the three "Light / Dark / Match system" buttons below the links are decoration for a sign-in page. | `signin-{390,1366}-light` |
| `/join` | `Join.tsx` | fine | Same shell, four fields. | 390 (seen): good; helper "12 or more characters, with a letter and a digit" is a short line, acceptable. | `join-{390,1366}-light` |
| `/reset` | `Reset.tsx` | fine | Same shell. | not inspected separately (same shell as join) | `reset-{390,1366}-light` |
| `/pin-reset` | `PinReset.tsx` | fine | Needs a session; PIN screens (`stepup/*`) are off limits for this pass. | not inspected | `pinreset-*` |

### Dialogs and sheets (all in `Modal`: centred card on laptop, bottom sheet on phone)

| Dialog | File | Verdict | Notes | Shots |
|---|---|---|---|---|
| Send a message | `broadcasts/SendDialog.tsx` | **in scope (small)** | 3 selects (Group, Style, Show for), title and body with counters, acknowledgement checkbox. Phone sheet is fine. Style should be two picture cards with a live preview, the expiry a short segmented control ("1 hour / 1 day / 1 week / Until I cancel"). | `dlg-send-message-*` |
| Lock this PC (message and contact) | `broadcasts/LockCard.tsx` (inside device detail) | planned: `device-detail.md` | | |
| New group / Edit group | `Groups.tsx:144`, `GroupDetail.tsx:161` | fine | Name + description. | `dlg-new-group-*` |
| Delete group | `GroupDetail.tsx` `DeleteGroup`, `ConfirmDialog` | fine | Type-to-confirm; the "has dependents" refusal is explained. | |
| Assign app / Edit assignment | `groups/AssignmentDialogs.tsx` | **in scope (small)** | App dropdown (needs a searchable picker with icons), "Who sees it" with a 2-line hint, two pin checkboxes. Good phone behaviour. | `dlg-assign-app-*` |
| Add employee to group | `GroupDetail.tsx` `AddEmployeeDialog` | fine | Search-first picker, results table with Add. | `dlg-group-add-employee-*` |
| Roll back | `rollout/RollbackDialog.tsx` | **in scope (with Rollout)** | Version dropdown ("Version 7: Lockdown settings changed (Nov 25, 2026)") and three ring checkboxes. | `dlg-rollback-*` |
| Allow a program | `lockdown/AllowDialog.tsx` | planned: `lockdown.md` | | |
| Wi-Fi password | `networks/PassphraseDialog.tsx` | planned: `enrollment-networks.md` | | |
| Add / remove member, role | `settings/MembersTab.tsx` | planned: `settings.md` | | |
| PIN, passkey, step-up | `stepup/*` | not touched (rule) | | |
| Add file type | `FileTypes.tsx:175` | **in scope (small)** | Raw extension input plus a program dropdown. | `dlg-add-filetype-*` |

## (b) Not-yet-planned pages, in priority order

Priority = how often a normal user sees it times how far it is from the bar.

1. **Group detail `/groups/:id`.** The page a customer lands on after the overview; the stacked layout is the clearest
   "stack of full-width sections" in the product.
   - Laptop: header (name, counts, one primary "Assign app", the rest in a "More" menu: Lockdown, Rollout, Edit,
     Delete), then tabs or a 2:1 split: main = Apps (cards with icon, audience, pins) and PCs; aside = People,
     "Protection" summary linking to lockdown, activity. Wide: three columns (Apps | PCs | People).
   - Move "Display and memory" to an "Advanced" disclosure (default Automatic) or into the group's settings tab.
   - Phone: one column with a sticky "Assign app"; every table must show its row actions (today they vanish at 390).
   - Delete moves into the "More" menu (danger, type to confirm stays).
   - One pager per list, and lists show at most 5 rows with "See all" (Devices, People, History).
2. **Overview `/`.** The first screen every day.
   - A status line first ("All 523 PCs are fine" or "3 things need you") instead of four equal stat cards; stats
     become a compact strip (phone: 2x2).
   - "Needs your attention" as a card grid (icon, one short sentence, one button), most urgent first, max 5 shown.
   - "Failed installs" becomes a top-5 list with "See all" (today a paginated table is the longest thing on the
     page). "Recent activity" stays an aside; on wide screens a third column.
   - Plain words: remove "Convex" from user text (`lib/strings.ts:337-338`, `largeFleetTitle` / `largeFleetDetail`), "Lockdown policy not applied" becomes
     "Protection could not be applied on 3 PCs".
3. **Rollout `/groups/:id/rollout`.** Technical (rings, bake time, promotion) and the least tolerable stack.
   - Top: a staged pipeline (three connected stages Pilot, Early, Everyone with the current version and PC count
     in each, the next action on the active stage). Phone: vertical stepper.
   - Names for non-technical users: "Test PCs / Early PCs / Everyone else" with an (i); "Promote" becomes "Send to
     Early PCs" / "Send to everyone".
   - Automatic promotion: one three-way choice (Off / Careful / Fast) that sets the two numbers; the numbers move
     under "Advanced" with the (i) help, not full-width inputs.
   - Health and "PCs and their rings" side by side on laptop; Roll back dialog defaults to "the last version" and
     all rings, the version list is one click deeper.
4. **Employee detail / new `/employees/new`, `/employees/:id`.**
   - Two columns on laptop: Profile (name, sign-in name filled from the name, group chips) and an aside
     (Password, Account, History). On "new", the aside is a live summary ("Maria can sign in on 3 PCs and sees 12
     apps").
   - Groups and Extra apps become pickers with chips (`SearchSelect` multi) instead of unbounded checkbox lists.
   - "Storage quota (GB)" moves under Advanced; "First password" becomes "Set a password now" with a Generate
     button (or "Employee sets it on first sign-in" if the product supports it: ask the owner).
5. **Messages (Broadcasts) compose and page.** The list is covered by the lists plan; the page needs a live
   "what is on screen right now" strip, and the dialog a preview (the `Preview` component exists), Style as two
   picture cards, expiry as a segmented control, Group as a searchable picker including "Everyone".
6. **Audit `/audit` wording and filters.** Table layout is covered by the lists plan. Not covered: plain-language
   details (no field names), a time zone shown as "your time", filter chips (who / what / which PC / date range), a
   short "Print" explanation.
7. **File types dialog and page.** Offer common types as chips (PDF, Word, Excel, Pictures, Music, Video, Text,
   Zip) and put free typing under "Other"; program as a searchable picker. Page itself is fine.
8. **Assign app dialog** (small, but the Apps flow uses it): searchable app picker with icons, audience as two
   radio cards ("Everyone in the group" / "Only some people"), pins as one line with two icons.
9. Public pages, NotFound, Gallery: fine as is. Optional polish: drop the theme switcher from the sign-in card.

## (c) Forms inventory (owner requirement 5)

Every form found in code (`useForm`, `Field`, `Input`, `Textarea`, `NativeSelect`). For each input a normal user
would not understand: what it is, and the recommendation. "A" automate, "D" default, "H" hide under Advanced,
"P" turn into an interactive picker. Forms whose page is planned elsewhere are listed too, so the plans can be
checked against this list.

### Groups, employees, messages, file types (not yet planned)

| Form (file) | Input | Why a normal user does not understand it | Recommendation |
|---|---|---|---|
| Group display card (`display/GroupDisplayCard.tsx:56-78`) | Display mode (Automatic / Lite / Standard), "Web app windows open at once" (Default Lite 3, Standard 8), "Close idle web app windows" (Default Lite 30 minutes, Standard never) | Lite/Standard, window caps and idle timers are performance tuning. | **H**: whole card under Advanced, default Automatic, one line "Older PCs automatically use a lighter look" with (i). Keep the three controls inside. |
| Device display card (`display/DeviceDisplayCard.tsx:52`) | Display mode per PC | Same. | **H** (device-detail plan). |
| Rollout settings (`rollout/AutoPromoteCard.tsx:87,90`, switches) | "Promote automatically", "Wait before promoting (hours)" 1-168, "Stop the rollout when this share of PCs fail (%)" 1-100, "Return the pilot ring to the early version when the rollout halts" | Bake time, failure threshold, and halting are release-engineering terms. | **A+D+H**: one choice "Move on by itself: Off / Careful / Fast" mapping to the numbers (for example 24 h / 20 percent and 6 h / 40 percent); the raw numbers and the "return the pilot ring" switch under Advanced. |
| Rollout rings (`rollout/MembersCard.tsx`, `RingsCard.tsx`, `PointersCard.tsx`) | Ring names Pilot / Early / Everyone; "Put selected PCs in" | Ring jargon. | **D+P**: rename for users ("Test PCs", "Early PCs", "Everyone else"), default the first PC into Test automatically when the user turns staging on, picker with PC names. |
| Rollback dialog (`rollout/RollbackDialog.tsx:90,101`) | Go back to (version number + change title), Which rings go back | Version numbers and rings. | **D**: default to the previous change ("Undo: Lockdown settings changed, Nov 25") with all rings ticked; "Choose another version" and ring ticks under Advanced. |
| Assign app (`groups/AssignmentDialogs.tsx:28,92`) | App, Who sees it (Everyone / Only selected employees), pins | "Only selected employees" is confusing next to groups. | **P+D**: searchable app picker with icons; default "Everyone in the group"; the second choice says "Only people I choose" with (i). |
| New/edit employee (`EmployeeDetail.tsx:252-319`) | Full name, Username (letters, digits, dots, dashes, underscores), Storage quota (GB, empty = default, 0 = unlimited), Groups, Extra apps, First password | "Username" format rules; quota with a magic 0; Extra apps beyond groups' apps. | **A**: derive the username from the name (`maria.fernanda`) and show it as an editable chip; **H**: quota under Advanced with the default shown ("Uses the organization default, 10 GB"); **P**: groups and apps as searchable chips; password: "Generate" button. |
| Employee password (`EmployeeDetail.tsx:436-439`) | New password, Repeat | Fine. | **A**: Generate + Copy; no repeat field when generated. |
| Send message (`broadcasts/SendDialog.tsx:97-124`) | Group, Style (Banner / Full screen), Title, Message, Show for, Ask for an acknowledgement | Fine mostly; "acknowledgement" and the counters (80 and 500 characters) are noise. | **P+D**: Style as two picture cards with a live preview; Show for as a segmented control, default 1 day; counters only appear near the limit; acknowledgement under the Full screen card. |
| Lock this PC (`broadcasts/LockCard.tsx:87,90`) | Message, Contact | Fine. | **D**: default message and contact from the organization. |
| File type (`FileTypes.tsx:175,180`) | Extension (".pdf"), Program | An extension with a dot is technical. | **P**: chips of common types (PDF, Word, Excel, Pictures, Music, Video, Text, Zip) that fill the extension; "Other" reveals the raw input; program = searchable picker showing only apps that open files. |
| Group new/edit (`Groups.tsx:144`, `GroupDetail.tsx:161`) | Name, Description | Fine. | none |
| Sign-in, Join, Reset (`SignIn/Join/Reset.tsx`) | Email, Password, Invite code, Reset code, New password | Fine. | none; the "12 or more characters, with a letter and a digit" line stays visible (it is an action hint). |

### Forms owned by other plans (check each plan against this list)

| Form (file) | Input | Why a normal user does not understand it | Recommendation |
|---|---|---|---|
| Windows program (`AppEdit.tsx:686-814`, `AppInstaller.tsx`) | Package id (winget) | Package IDs like `Mozilla.Firefox`. | **P**: popular-apps gallery and search fill it; the field stays under "I know the package id". |
| | Version | | **D**: empty = newest; hide under Advanced. |
| | Installer address, SHA-256, Size | URL, hash, bytes. | **A**: paste the address, Rulebox reads the file's type, hash and size (the "Detect" and "Check a file" actions already exist); show "Verified" with (i); fields under Advanced. |
| | Silent install arguments, Installer type (NSIS, Inno, WiX Burn, InstallShield...), Success exit codes (0, 3010, 1641), Give up after (minutes), Expected signer | Pure installer engineering. | **A+H**: auto-chosen by Detect; show one line "Installs silently"; all five under Advanced. Owner rule 3. |
| | Answer file address and SHA-256 (InstallShield, `/r /f1"C:\setup.iss"` instructions) | | **H**: only appears when the detected installer needs it, with a step-by-step help in an (i) or link. |
| | MSI product code | GUID. | **A**: read from the MSI; hidden. |
| | Program path, Start arguments, File argument (`{file}`) | Paths with placeholders. | **A+H**: program path suggested from winget; the rest under Advanced. |
| | Folders to clear at sign-out (`{LocalAppData}\Vendor\App`) | Registry-ish path tokens. | **H**: Advanced, plus a "Clear this app's data at sign-out" switch with common presets. |
| | Tile colour | | **D**: random from the name; picker only on edit. |
| Updates card (`AppUpdates.tsx`) | Update mode (Keep this version / The program updates itself / Rulebox publishes updates), Version, Publisher, Product, Lowest version to keep, Feed address, Vendor's public key, Platform (`windows-x86_64-nsis`), Install updates when | Update channel engineering. | **D+H**: default per app (browsers: "The program updates itself"); modes shown as three plain cards; publisher read from the installer signature; feed fields, public key, platform and "lowest version" under Advanced. |
| Website (`AppEdit.tsx:615-656`, `AppBrowser.tsx`) | Address, Allowed domains (`*.example.com`, one per line), Opens in (Rulebox window / Edge / Chrome), Chrome program, Allowed sites list | Wildcards. | **P**: owner requirement: interactive example ("also allow mail.example.com, shop.example.com") with a live "opens / blocked" preview; Opens in as three cards, Chrome program picked automatically when exactly one Chrome app exists. |
| Site permissions (`AppPermissions.tsx`) | Camera, microphone, screen sharing, clipboard, notifications, downloads, printing, location | Understandable, but 8 switches at once. | **D**: presets ("Normal website", "Video calls", "Strict") with the 8 switches under Advanced. |
| Wi-Fi (`WifiEdit.tsx:274-321`) | Name, Network name (SSID) with a byte counter ("12 of 32 bytes"), Security (WPA2/WPA3...), Hidden network, Password | SSID, bytes, security protocols. | **A+H**: security defaults to WPA2/WPA3 and stays under Advanced; byte counter appears only when over the limit; the password field is in the same form. |
| Printer (`PrinterEdit.tsx:264-345`) | Connection kind (IPP / Raw / LPR / Shared name), Printer address (URL or IP), Port (9100), Queue name, Driver, Default for groups | Printer protocols. | **A+P**: choose "Network printer" or "Shared from a PC" first; address with an example; port and queue only for the kinds that need them, under Advanced; driver picker with "Windows chooses" as the default. |
| Driver (`DriverEdit.tsx:293-356`) | Device class, What you are delivering (INF zip / EXE / MSI), URL, SHA-256, Size, INF file inside the zip, Silent arguments, Success exit codes, "Printer driver names it delivers" | INF, class, hash, exit codes. | **A+H**: same treatment as Windows programs (auto-detect from the file, hashes and sizes automatic); INF path, arguments, codes and "provides" names under Advanced. |
| Approved drivers (`networks/ApprovedDrivers.tsx:98`) | Driver names | "Exactly as Windows shows it". | **P**: choose from names reported by the PCs. |
| Enrollment (`Enrollment.tsx:294-353`) | Group, Uses (1-100), Valid for + custom unit, Label | "Uses" and expiry are technical for a first-time user. | **D**: defaults (one group chosen automatically, 1 day, 20 uses); Label optional under Advanced. |
| Lockdown (`Lockdown.tsx:79,229-235`, `lockdown/*`) | Program rules (AppLocker / App Control / Process watch each Off / Audit / Enforce), Wrong passwords before the lock, Lock for (minutes), Count within (minutes), USB hours | Product names of Windows features. | **D+H**: presets first ("Standard protection"), switches under Advanced (`lockdown.md`). |
| Allow a program (`lockdown/AllowDialog.tsx:98-154`) | How to recognise the program (publisher / exact file / folder), Folder (`{ProgramFiles}\Acme`), groups, program, note | Folder tokens, "exact file". | **A**: default to publisher when signed; "folder" only when it is the only option, with the token prefilled; hide the choice when only one is possible (`lockdown.md`). |
| Device (`DeviceDetail.tsx:475,564`, `lockdown/DeviceCards.tsx:175`) | Group, Rename, Rollout ring | "Rollout ring" is jargon. | **H**: ring under Advanced, "Test PC" switch instead. |
| Organization (`settings/OrganizationTab.tsx:86-97`) | Name, Offline sign-in (days), Default storage quota (GB), Power options | Quota and offline days are unusual. | **D+H**: defaults; both under Advanced (`settings.md`). |
| Admin exit (`settings/AdminExitTab.tsx:94,218,233`) | Key combination (`Ctrl+Shift+F12`), PIN | Hotkey syntax. | **P**: press-the-keys recorder instead of typing syntax (`settings.md`). |
| Updates (`settings/UpdatesTab.tsx:160-203`) | Version, URL, SHA-256, Size in bytes | All four are technical. | **A**: pick a GitHub release; manual under Advanced (`settings.md`, already planned). |
| Members (`settings/MembersTab.tsx:363-419`) | Email, Role | Role names with long help. | **D**: default role; role help as (i) (`settings.md`). |
| Security (`settings/SecurityTab.tsx`) | Passkey name, current/new/repeat password | Fine. | none |
| Signing (`settings/SigningTab.tsx`) | Signing key actions, CLI note ("Never paste the secret anywhere else... shell history") | Key, rotation, CLI. | **H**: whole tab as Advanced for owners (`settings.md`). |

## (d) Native selects and helper paragraphs

### Every native `<select>` (all through `NativeSelect` from `@rulebox/ui`; 38 call sites)

To be replaced by `Select` / `SearchSelect` (README contract). Suggested type in brackets: **S** simple, **Q** searchable
(long, growing lists).

- `components/DataTable.tsx:215` sort (S); `components/Pager.tsx:104` rows per page (S, compact)
- `screens/Devices.tsx:206` group filter (Q); `screens/Employees.tsx:125` group filter (Q)
- `screens/DeviceDetail.tsx:477` group (Q)
- `screens/Enrollment.tsx:296` group (Q), `:318` valid for (S), `:342` custom unit (S compact)
- `screens/AppEdit.tsx:1085` group (Q), `:1096` audience (S)
- `screens/AppBrowser.tsx:70` Chrome program (Q)
- `screens/AppInstaller.tsx:176` installer type (S)
- `screens/AppUpdates.tsx:117` install updates when (S)
- `screens/DriverEdit.tsx:298` device class (S), `:309` what you are delivering (S)
- `screens/PrinterEdit.tsx:269` connection kind (S), `:312` driver (Q)
- `screens/WifiEdit.tsx:304` security (S)
- `screens/FileTypes.tsx:182` program (Q)
- `screens/Lockdown.tsx:79` generic Off / Audit / Enforce select (S, used several times)
- `screens/lockdown/AllowDialog.tsx:100` how to recognise (S), `:144` program (Q)
- `screens/lockdown/DeviceCards.tsx:177` rollout ring (S), `:264` USB hours (S)
- `screens/broadcasts/SendDialog.tsx:99` group (Q), `:112` style (S), `:126` show for (S)
- `screens/display/DeviceDisplayCard.tsx:52` mode (S); `screens/display/GroupDisplayCard.tsx:58` mode, `:66` window cap, `:78` idle close (S)
- `screens/groups/AssignmentDialogs.tsx:28` audience (S), `:92` app (Q)
- `screens/rollout/RollbackDialog.tsx:90` version (S)
- `screens/settings/MembersTab.tsx:368` role (S), `:419` role (S)
- Out of scope but present: `src/Gallery.tsx:608` (demo only).

Note: the Settings "Program rules" and "Security" dropdowns of the owner's list are `Lockdown.tsx:79` (rules) and
`WifiEdit.tsx:304` (Wi-Fi security); the Settings > Security tab has no select.

### Long helper paragraphs to move into an (i) tooltip

A paragraph is "long" when it is more than one short sentence under a field or heading. Keep only the line a user
needs to act on; errors stay inline. Paths are relative to `apps/dashboard/src/`; the number is the line of the
string.

- **Lockdown** `screens/lockdown/strings.ts`: 45 rulesLead, 53 appLockerHelp, 55 appControlHelp, 63 procWatchHelp,
  66 staffLead, 105 usbLead, 125 usbRetroactiveHint, 129 winCombosHelp, 131 accessibilityToolsHelp, 135
  autoRecoveryHelp, 137 safeModeGuardHelp, 142 staffTuningHelp, 146 noPrintingHelp, 151 wifiManagedOnlyConfirmHint,
  152 wifiManagedOnlyHelp, 155 exceptionsLead, 162 breaksOnUpdateHelp, 225 allowLead, 232-236 kindHelp, 243
  folderHint; `screens/lockdown/deviceStrings.ts`: 84 usbLead.
- **Networks** `screens/networks/strings.ts`: 77-82 securityHelp, 84 hiddenHint, 88 groupsHint, 110 passphraseLead, 142
  printersLead, 152-161 kindHelp, 168-173 addressHint, 186 portHint, 189 queueHint, 195 printerNameHint, 205
  printerGroupsHint, 207 defaultsHint, 229 driversLead, 239-243 driverKindHelp, 246 driverClassHint, 252
  driverUrlHint, 254 driverShaHint, 256 driverSizeHint, 258 driverInfHint, 260 driverArgsHint, 262 driverCodesHint,
  264 driverProvidesHint, 265 driverGroupsHint, 337 approvedLead, 342 approvedFieldHint.
- **Apps** `lib/screenStrings/appEdit.ts`: 22 allowedDomainsHint, 24 permissionsHint, 25 permissionsSub, 37
  printingNote, 49-55 sourceHints, 71 removeExeNote, 78 fileArgHint, 80 resetFoldersHint;
  `appInstaller.ts`: 12 detectHint, 16 checkFileHint, 58 successCodesHint, 60 timeoutHint, 62 publisherHint, 67
  answerHint (a 4-line how-to: needs its own help panel, not even a tooltip), 70 answerUrlHint; `appUpdates.ts`: 8
  versionHint, 16-22 updateModeHelp (3 paragraphs), 23 browserForced, 25 publisherHint, 27, 30, 32 feedHint, 35,
  37; `appBrowser.ts`: 9-13 kindHelp, 14 fallbackNote, 16 chromeAppHint, 24-30 limits (a 4-bullet list shown
  inline: collapse into an (i) or a "What browser mode cannot do" disclosure), 44 sitesHint.
- **Rollout** `screens/rollout/strings.ts`: 19 ringsLead, 23 ringsOffNote, 83 rollbackLead, 95 autoLead, 99
  autoBakeHint, 103 autoRollbackHint, 117 membersLead.
- **Display** `lib/screenStrings/display.ts`: 4 groupLead, 5 deviceLead, 12 autoNote, 14 windowCapHint, 18
  idleCloseHint.
- **Groups and employees**: `screens/groups/strings.ts:29` audienceHint; `lib/screenStrings/employee.ts:9`
  usernameHint, 11 quotaHint, 19 passwordInitialHint, 33 disabledHelp.
- **Messages** `screens/broadcasts/strings.ts`: 47 styleHelp, 53 ackHint, 77 messageHint, 79 contactHint, 89
  revokedNote.
- **Enrollment** `screens/enrollment/strings.ts`: 18, 22, 34, 36 (all short; turn into (i) when the form is
  rebuilt).
- **Settings** `screens/settings/strings.ts`: 31 nameHint, 33 offlineDaysHint, 38 powerHint, 49 enabledHint, 51
  hotkeyHint, 115 formLead, 117 versionHint, 119 urlHint, 121 shaHint; `lib/screenStrings/settings.ts:33` cliNote.
- **Overview** `lib/strings.ts:337-338` (`largeFleetTitle` / `largeFleetDetail` name the Convex dashboard: remove the
  vendor name) and the attention sentences in `lib/strings.ts` (overview group).
- **PIN screens** `lib/stepup/strings.ts` (43, 67, 79, 83, 121, 160, 172, 180): not touched in this pass (rule).

## Summary

- 38 native selects, about 55 helper paragraphs, 3 forms (Windows program, driver, Wi-Fi/printer) that ask for
  technical input up front.
- Not-yet-planned and in scope: Group detail, Overview, Rollout, Employee detail/new, Messages compose, Audit wording,
  File types dialog, Assign-app dialog.
- Fine as is: sign-in, join, reset, pin-reset, 404, group new/edit/delete dialogs, add-employee-to-group dialog.
