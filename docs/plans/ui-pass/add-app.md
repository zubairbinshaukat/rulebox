# UI pass: Add app, edit app, popular apps gallery (2026-11-28)

Routes: `/apps/new`, `/apps/new?kind=web|desktop` (plus the new `gallery=`, `winget=`, `source=`, `url=` parameters),
`/apps/:id` (`?tab=`). Spec: `docs/plans/follow-ups.md` 0c, "Users are not technical", "Automate the complex things";
shared contract: `docs/plans/ui-pass/README.md`; behaviour: PRD 6, 6.1, 6.2, 6.3, 7.2, 7.3, 23.2, 24.1 and
`docs/plans/phase-6-installer-pilot.md` 4.4, 4.7, 4.8, 4.9. Planning only; every choice in "Decisions taken" is the
recommended option (owner reviews later).

Facts checked in the code and on the network for this plan (2026-11-28):

- **Allow-list semantics (built-in window):** `apps/staff-app/src-tauri/src/webapp/allow.rs`. An entry `E` allows host
  `H` when `H == E` or `H` ends with `"." + E` (label by label), the port must be equal (no port = 443 only), an IP
  matches only an identical IP, https only, no login in the address. So **every entry already includes all its
  subdomains**; the app's own host is always entry 1 (`convex/lib/appRules.ts` `normalizeWeb`).
- **Browser mode (Edge/Chrome):** the agent turns `x` and `*.x` alike into `https://x` in `URLAllowlist`
  (`apps/agent/src/lockdown/browser/tests.rs` "the_allow_list_is_the_union..."), which also includes subdomains.
- **Likely bug found (unverified):** in the built-in window a `*.x` entry is parsed by the `url` crate as the literal
  host `*.x` (`*` is not a forbidden host code point), so `*.cdn.example.com` probably allows **nothing** there. No test
  in `step15_tests.rs` covers `*.`. See D28 and Section 10.
- **Validation (unchanged):** `domain()` in `apps/dashboard/src/lib/validate.ts` and `domainProblem` in
  `convex/lib/hostRules.ts`: lower-case `a.b` or `*.a.b`, labels `[a-z0-9-]{1,63}`, at least 2 labels, no port, no
  scheme, at most 20 extra entries (`MAX_ALLOWED_DOMAINS`). The address: `webUrl` / `webUrlProblem` (https, no
  credentials, no local names, no private IPv4, no IPv6 literal, a dot in the name).
- **winget (live check of `microsoft/winget-pkgs`, 2026-11-28):** every ID in Section 7 exists. `Microsoft.Teams` is
  MSIX/zip only and `SlackTechnologies.Slack` is `Scope: user` only, so `pickInstaller` (`convex/lib/winget.ts`,
  supports msi/wix/exe/inno/nullsoft/burn, machine or unspecified scope, no ARM) refuses both today.
- **There is no winget search today.** Only `apps:resolveWinget` (an exact, case-sensitive ID; cached 24 h in
  `wingetCache`, shared by all orgs; rate-limited 20/min per org).
- **Detection exists:** `convex/lib/installerDetect.ts` `detectInstaller` (OLE magic -> MSI; PE sections/manifest/strings
  -> Burn, NSIS, Inno, Advanced Installer, InstallShield MSI/Script; else plain `exe`, low confidence), used by
  `apps:inspectInstaller` (3 Range requests, 30/h) and by `src/lib/apps/localInstaller.ts` (in the browser, plus SHA-256).
  A streaming download+hash already exists for vendor feeds (`convex/lib/feed/fetch.ts`, 512 MiB cap).
- **Size budget:** the `AppEdit` route chunk is 29.2 of 29.5 KB gzip (`apps/dashboard/scripts/size.mjs`). The redesign
  must split it, not raise it.

## 1. Inventory of today's controls

| # | Control | Kind | Shown when | Source |
|---|---|---|---|---|
| 1 | Name (required) | both | always | `screens/AppEdit.tsx` General card |
| 2 | Description (optional) | both | always | `AppEdit.tsx` General |
| 3 | Tile colour (12 radios) | both | always | `AppEdit.tsx` `HuePicker` |
| 4 | Address + "Fetch details" button | web | always | `AppEdit.tsx` |
| 5 | Fetched icon preview | web | after fetch | `AppEdit.tsx` |
| 6 | Allowed domains (textarea, one per line, `*.` allowed) | web | always | `AppEdit.tsx` |
| 7 | "A new site starts with the defaults..." text | web | new | `AppEdit.tsx` |
| 8 | Opens in (Rulebox window / Edge / Chrome) + help + fallback note | web | always | `screens/AppBrowser.tsx` `OpensInCard` |
| 9 | Chrome program (select) + "no Chrome program" notice + warnings | web | Chrome picked | `AppBrowser.tsx` `ChromePicker` |
| 10 | "What browser mode cannot do" list | web | Edge/Chrome | `AppBrowser.tsx` `BrowserLimits` |
| 11 | Site permissions: 8 switches, defaults, Save permissions | web | edit | `screens/AppPermissions.tsx` |
| 12 | Blocked in the last 30 days + Allow per kind | web | edit | `AppPermissions.tsx` |
| 13 | Source (winget / MSI / EXE / Portable / Already installed) | desktop | always | `AppEdit.tsx` Source card |
| 14 | Package id, Version, Resolve / Check for update | desktop | winget | `AppEdit.tsx` |
| 15 | Resolved summary (id, kind, SHA-256, size, switches, installer URL) | desktop | after resolve | `AppEdit.tsx` `ResolvedSummary` |
| 16 | Installer address | desktop | msi/exe/portable | `AppEdit.tsx` |
| 17 | Detect, Check a file on this computer, result notices | desktop | msi/exe | `screens/AppInstaller.tsx` `DetectRow` |
| 18 | SHA-256 | desktop | msi/exe/portable | `AppEdit.tsx` |
| 19 | Silent install arguments (+ "edited") | desktop | exe | `AppEdit.tsx` |
| 20 | "EXE installs can't be removed" note | desktop | exe | `AppEdit.tsx` |
| 21 | MSI product code | desktop | msi | `AppEdit.tsx` |
| 22 | Uninstall from PCs when unassigned | desktop | msi/portable/winget-msi | `AppEdit.tsx` |
| 23 | Installer type (select) | desktop | exe | `AppInstaller.tsx` `InstallerCard` |
| 24 | Success exit codes | desktop | exe | `InstallerCard` |
| 25 | Give up after (minutes) | desktop | msi/exe | `InstallerCard` |
| 26 | Expected signer + "Use <signer>" | desktop | msi/exe | `InstallerCard` |
| 27 | Use an answer file, answer URL, answer SHA-256 | desktop | exe | `InstallerCard` |
| 28 | Program path (`{ProgramFiles}\...exe`) | desktop | always | `AppEdit.tsx` Program card |
| 29 | Start arguments | desktop | always | `AppEdit.tsx` |
| 30 | File argument (`{file}`) | desktop | always | `AppEdit.tsx` |
| 31 | Folders to clear at sign-out | desktop | always | `AppEdit.tsx` |
| 32 | Browser rules: allowed sites textarea + empty warning + limits | desktop | exe is chrome/msedge | `AppBrowser.tsx` `BrowserRulesCard` |
| 33 | Version | desktop | always | `screens/AppUpdates.tsx` |
| 34 | Update mode (Pinned / Vendor / Managed) | desktop | always (forced Vendor for browsers) | `AppUpdates.tsx` |
| 35 | Publisher, publisher product, lowest version | desktop | Vendor | `AppUpdates.tsx` |
| 36 | Feed address, feed key, feed target, auto-publish | desktop | Managed | `AppUpdates.tsx` |
| 37 | Apply when, roll back on failure, Roll back to x | desktop | Managed | `AppUpdates.tsx` |
| 38 | Feed status line: Approve, Dismiss, Check now, Pause/Resume | desktop | edit, feed | `AppUpdates.tsx` `FeedStatusLine` |
| 39 | Groups card + Assign modal (group, audience, pins) | both | edit | `AppEdit.tsx` `AssignmentsCard` |
| 40 | Opens these file types + Manage link | desktop | edit | `AppEdit.tsx` |
| 41 | History | both | edit | `components/HistoryPanel.tsx` |
| 42 | Install status (state buttons, list, Retry) | desktop | edit | `AppEdit.tsx` `InstallStatus` |
| 43 | Archive / Restore / Delete (type the name) | both | edit | `AppEdit.tsx` `ArchiveActions` |
| 44 | Create/Save, Cancel, unsaved hint, error summary | both | always | `AppEdit.tsx` `AppForm` |
| 45 | Apps list: "Website" + "Windows program" add buttons | list | admin | `screens/Apps.tsx` |

Strings: `src/lib/screenStrings/appEdit.ts`, `appInstaller.ts`, `appBrowser.ts`, `appUpdates.ts`, `apps.ts`,
`installRefusals.ts`. Logic: `src/lib/apps/{installerRules,installerPrefill,localInstaller,browserRules,updateRules}.ts`,
`src/lib/validate.ts`.

## 2. Classification

U = up front, D = one click deeper ("More options" disclosure or another tab), A = Advanced (`dash-advanced`),
F = auto-filled, R = removed.

| # | Control | Class | Reason / how it is automated |
|---|---|---|---|
| 1 | Name | U + F | Filled from the gallery, winget locale, the installer's product name, or the site's manifest; editable inline |
| 2 | Description | D | Rarely needed; "Add a description" link in More options |
| 3 | Tile colour | D + F | Picked automatically (gallery hue, site theme colour via `nearestHue`, else a hash of the name); "Appearance" in More options |
| 4 | Address | U | The one thing a website needs. `https://` is added when missing; "Fetch details" runs by itself (D17) |
| 5 | Icon preview | U + F | Shown next to the name once fetched |
| 6 | Allowed domains | U (picker) + A (raw list) | Replaced by `SiteAccessPicker` (Section 6); the raw list stays under Advanced for power users |
| 7 | Permissions hint | U (1 line) | "Camera, microphone and location start off. Change them after adding." |
| 8 | Opens in | D | Default Rulebox window is right for most; Edge/Chrome is a deliberate choice |
| 9 | Chrome program | D | Only after picking Chrome; auto-picked when exactly one Chrome program exists |
| 10 | Browser limits list | D -> (i) | Moves into the InfoTip of the Edge/Chrome options |
| 11 | Permissions switches | edit tab | "Permissions" tab; gallery websites get sensible permissions automatically (D22) |
| 12 | Blocked counts + Allow | edit tab | Same tab, top |
| 13 | Source selector | R | Replaced by the start page choice (gallery, own installer, other ways); MSI vs EXE is detected, never picked |
| 14 | Package id / Version / Resolve | R (as fields) | Gallery click or the search's "Look up in winget" runs Resolve by itself; version = newest; "Choose another version" under Advanced |
| 15 | Resolved summary | F -> status lines | Becomes "Installs silently", "Checked before it installs", "Version 24.08"; raw values under Advanced |
| 16 | Installer address | U | Needed (no hosting yet); paste a link, the check runs by itself. Upload slot reserved for Tigris hosting |
| 17 | Detect / Check a file | F + U (secondary) | Replaced by the automatic "Checking the installer" (new `apps:fingerprintInstaller`); "I have the file" stays as a secondary button (no upload) |
| 18 | SHA-256 | F + A | Filled by the server check, the local file check, or winget; shown read-only under Advanced with "Change" |
| 19 | Silent switches | F + A | Auto from the rules table (Section 5); "Installs silently (i)" line; field under Advanced with "Use automatic" |
| 20 | EXE not removable note | (i) | InfoTip on the uninstall line |
| 21 | MSI product code | F + A | From winget; otherwise Advanced |
| 22 | Uninstall when unassigned | D + F | Default on for MSI/portable, impossible for EXE; one line "Removed from PCs when you take it away (i)" with a switch in More options |
| 23 | Installer type | F + A | From detection; Advanced |
| 24 | Success exit codes | F + A | From the technology (`prefillFor`); Advanced |
| 25 | Timeout | A | Default 30 min is right |
| 26 | Expected signer | A + F | "Use <signer>" stays; Advanced |
| 27 | Answer file | A, raised | Only shown up front (as a blocking notice that opens Advanced) when the installer needs one (InstallShield Script) |
| 28 | Program path | F, else U (guided) | Gallery entries carry it; winget gives the folder; when unknown it is required up front as a guided "Program to start" input (root picker + path), Section 3.3 |
| 29 | Start arguments | A | Rare |
| 30 | File argument | A + F | Default `{file}` |
| 31 | Folders to clear | A | Rare and technical (path templates) |
| 32 | Browser rules (Chrome/Edge program) | U for browsers | A browser with no sites is useless; chip editor with suggestions instead of a textarea; raw list under Advanced |
| 33 | Version | F + Updates tab | From winget / file version; shown as text on review |
| 34 | Update mode | D (review) / Updates tab | Plain labels (D27); default Keep this version; browsers forced to "updates itself" |
| 35 | Publisher / product / lowest version | Updates tab | Only inside "The app updates itself"; publisher pre-filled from the signer or winget publisher |
| 36 | Feed fields | Updates tab, A | Inside "Rulebox updates it", under Advanced |
| 37 | Apply when / roll back | Updates tab | Inside Managed |
| 38 | Feed status line | Updates tab | Unchanged |
| 39 | Groups + Assign | "Who gets it" tab | After create the page lands here (D18) |
| 40 | File types | Details aside | Chips + Manage link |
| 41 | History | "Activity" tab | Its query runs only when the tab is open |
| 42 | Install status | "Installs" tab | Its two queries run only when the tab is open |
| 43 | Archive / Delete | header actions | Unchanged behaviour |
| 44 | Save / Cancel | sticky save bar | "Add <name>" on new; "Save changes / Discard" bar when dirty on edit |
| 45 | List add buttons | one "Add app" | Goes to `/apps/new` (D1) |

## 3. The new flow

### 3.1 Screens and states

1. **Start page `/apps/new`** (lazy chunk `AddAppStart`). Main action: pick an app.
   - Smart search: "Search, or paste a website address". Results (`SearchSelect`-style listbox): gallery matches;
     "Add the website https://<host>" when the text parses as a host or URL; "Look up <id> in the winget catalogue"
     when it matches the winget ID pattern (`v.wingetId`). A pasted winget.run / winstall.app / winget-pkgs URL is
     reduced to its ID. Both rows can show (`VideoLAN.VLC` is also host-shaped); the user picks.
   - Category chips (All, Browsers, Meetings and chat, Office and PDF, Photos video and sound, Tools) filter the grid.
   - Gallery grid of cards (letter tile, name, 3-6 word blurb, "Website" badge for web entries).
   - "Other ways to add": Website or web app; Your own installer (.exe or .msi link); disclosure "More" with
     Already on the PCs, A single program file (no install).
   - States: viewer (notice "Only an Admin or Owner can add apps", grid browsable, cards disabled); empty search
     result ("No popular app matches. Paste a website address or a winget ID."); plan limit reached (notice from
     `apps:count` is NOT queried here; the create call's `plan_limit` is shown on the review screen).
2. **Windows app review `/apps/new?kind=desktop&gallery=<key>` or `&winget=<id>`** (chunk `DesktopAdd`).
   Main action: "Add <name>".
   - States: resolving (skeleton of the status lines, "Looking up <name>..."); ready; already added (from
     `apps:byWinget`: notice "VLC is already in your apps" + "Open it", Add still possible); unsupported (plain
     sentence per reason + "Add it as a website" when the gallery entry has a web fallback, else "Use your own
     installer"); unreachable ("The app catalogue can't be reached right now. Try again in a minute." + Try again);
     program file unknown (guided input required, Section 3.3); warning entry (Firefox, D6).
3. **Own installer `/apps/new?kind=desktop&source=installer`** (same chunk). Main action: "Add <name>".
   - Step A, one field "Installer link" (+ secondary "I have the file" for a local check). On a valid https link,
     `apps:fingerprintInstaller` runs once ("Checking the installer... this can take a minute for a big file").
   - Step B (same page, appears below): name (from product name), status lines, program to start, More options,
     Advanced.
   - States: checking (progress text, Cancel), checked (silent / guess / unknown / needs answer file), too large
     (> 512 MiB: "This file is too big to check online. Choose the same file on this computer." -> local check, plus
     Range-based `inspectInstaller` for the type), blocked/unreachable/not an installer (inline error under the link).
4. **Other ways** `source=preinstalled` (only name + program to start) and `source=portable` (link + check; the
   path is fixed to `{RuleboxApps}\{AppId}\app.exe`, nothing to ask).
5. **Website `/apps/new?kind=web` (`&url=`, `&gallery=<key>`)** (chunk `WebAppForm`). Main action: "Add website".
   - Address -> details fetched by themselves (name, icon, colour) -> `SiteAccessPicker` + live preview -> More
     options (Opens in, Appearance, Description) -> Advanced (raw list).
   - States: empty (picker shows "Type the address first"), invalid address (inline error, picker hidden), fetching,
     fetch failed ("Couldn't read the site's name and icon. Type a name." - never blocking), ready.
6. **After create:** navigate to `/apps/<id>?tab=access&added=1`: success banner "<name> added. Choose who gets it."
   with the primary "Assign to a group" button (existing modal).
7. **Edit `/apps/:id`** (chunk `AppPage`): header (tile, name, kind pill, archived pill, Archive/Delete), PageTabs:
   - Windows app: Details | Who gets it | Installs | Updates | Activity
   - Website: Details | Who gets it | Permissions | Activity
   - Details and Updates share one form and one sticky save bar ("Unsaved changes - Save changes - Discard");
     Permissions keeps its own save (`apps:setPermissions`), its draft is lifted to the page so a tab switch keeps it.
   - Archived: warning notice under the header; viewer: read-only notice, no save bar.

### 3.2 Wireframes

Gallery, laptop (1366):
```
+--------------------------------------------------------------------------------------------+
| < All apps                                                                                 |
| Add an app                                                                                 |
| Pick a popular app, or add a website or your own installer.                                |
| [ (search) Search, or paste a website address ..................................... ]      |
| (All) (Browsers) (Meetings and chat) (Office and PDF) (Photos, video and sound) (Tools)    |
+------------------------------------------------------------------+-------------------------+
| [G] Google Chrome   [E] Microsoft Edge  [F] Firefox   [Z] Zoom   | Other ways to add       |
|  Web browser         Web browser        Web browser   Meetings  | +---------------------+ |
| [T] Microsoft Teams [S] Slack           [O] Outlook   [L] LibreO.| | (globe) Website or  | |
|  Website            Website             Website       Office    | |   web app           | |
| [A] Acrobat Reader  [S] SumatraPDF      [F] Foxit     [O] ONLYO. | +---------------------+ |
| [V] VLC             [I] IrfanView       [P] Paint.NET [G] GIMP   | | (box) Your own      | |
| [A] Audacity        [I] Inkscape        [7] 7-Zip     [N] Notep. | |   installer         | |
| [K] KeePassXC       [T] Thunderbird                              | +---------------------+ |
| App names are trademarks of their owners.                        | > More ways           |
+------------------------------------------------------------------+-------------------------+
```
Gallery, phone (390):
```
+------------------------------+
| = Rulebox             (acct) |
| < All apps                   |
| Add an app                   |
| [ Search, or paste a site  ] |
| (All)(Browsers)(Meetings)(Of>|  <- chips scroll sideways
| +-----------+ +-----------+  |
| | [G]       | | [E]       |  |
| | Chrome    | | Edge      |  |
| +-----------+ +-----------+  |
| | [F]       | | [Z]       |  |
| ...  (2 columns)             |
| Other ways to add            |
| [ Website or web app     > ] |
| [ Your own installer     > ] |
| > More ways                  |
+------------------------------+
```
Windows app review, laptop:
```
+------------------------------------------------------------------+-------------------------+
| < Add an app                                                     |  [V]  VLC media player  |
| Add VLC media player                                             |  VideoLAN               |
| +--------------------------------------------------------------+ |  (ok) Installs silently (i)
| | Name  [ VLC media player                     ]               | |  (ok) Checked before it |
| | (ok) Installs silently (i)                                   | |       installs (i)      |
| | (ok) Checked before it installs (i)                          | |  Version 3.0.24        |
| | (ok) From the winget catalogue, version 3.0.24 (i)           | |  Keeps this version     |
| | (ok) Removed from PCs when you take it away (i)              | |                         |
| | Starts  Program Files\VideoLAN\VLC\vlc.exe     [Change]      | |  [ Add VLC media player ]|
| +--------------------------------------------------------------+ |  Cancel                 |
| > More options  (updates, uninstall, appearance, description)    |                         |
| > Advanced      (install command, fingerprint, timeout, ...)     |                         |
+------------------------------------------------------------------+-------------------------+
```
Windows app review, phone: one column, the aside's summary is dropped (the status lines are in the main card),
a sticky bottom bar `[ Add VLC media player ]` (full width, safe-area padding).

Own installer, laptop (after the check):
```
| Installer link [ https://dl.vendor.com/pos-setup-2.4.exe        ]  (I have the file)       |
| (ok) Checked: Zahras POS 2.4, Inno Setup installer, 84 MB                                  |
| Name  [ Zahras POS ]                                                                       |
| (ok) Installs silently (i)          | (!) "best guess" variant shows a warning tone        |
| (ok) Checked before it installs (i)                                                        |
| Program to start (required)                                                                |
|   [ Program Files v ] \ [ Zahras\POS\pos.exe                 ]                             |
|   Usually under Program Files\Zahras. (i)                                                  |
| > More options    > Advanced                                       [ Add Zahras POS ]      |
```
Unknown installer state replaces the silent line with a warning card:
```
| (!) Rulebox can't tell how this installer runs silently.                                   |
|     Ask the vendor for its silent switches and enter them in Advanced.  [Open Advanced]    |
|     Common switches: [/S] [/silent] [/quiet] [/VERYSILENT]  (fills the field; try 1 PC)    |
```
Website form with the picker and preview, laptop:
```
+--------------------------------------------------------------+-----------------------------+
| < Add an app                                                 | What employees can open     |
| Add a website                                                |  open    shop.example.com/start
| Website address [ https://shop.example.com/start      ]     |  open    shop.example.com/any-page
| [S] Name [ Example Shop ]   (icon found)                     |  open    login.shop.example.com
|                                                              |  open    mail.example.com   |
| Which pages open (i)                                         |  open    accounts.google.com|
|   https:// [ shop ] . [ example.com ] /start                 |  blocked www.wikipedia.org  |
|            ^^^^^^^^^^^^^^^^^^^^^^^^^ highlighted = allowed   |  blocked http://shop.example.com
|   ( ) Only shop.example.com                                  |  ---------------------------|
|   (*) All of example.com  - also mail.example.com, www....   |  Try an address [         ] |
|                                                              |  -> opens / blocked + why   |
| Other sites it needs (i)                                     |                             |
|   [accounts.google.com x] [+ Google sign-in] [+ Microsoft    |  [ Add website ]            |
|   sign-in]  [ Add a site: login.example.com      ] [Add]     |                             |
| > More options (opens in, appearance, description)           |                             |
| > Advanced (edit the list by hand)                           |                             |
+--------------------------------------------------------------+-----------------------------+
```
Website form, phone: address, name, picker (the address chips wrap per label), "Other sites" chips, then the preview
as a compact list ("5 open, 2 blocked" summary line expands to the rows), sticky `[ Add website ]`.

Edit page, laptop:
```
| < All apps                                                                   [Archive]     |
| [V] VLC media player   (Windows app) (winget)                                              |
| [Details] [Who gets it 3] [Installs] [Updates] [Activity]                                  |
+------------------------------------------------------------------+-------------------------+
| Name [ VLC media player ]   Description [                  ]     | Where it comes from     |
| (ok) Installs silently (i)    (ok) Checked before it installs (i) | winget, 3.0.24          |
| Starts  Program Files\VideoLAN\VLC\vlc.exe   [Change]            | [Check for update]      |
| > More options   > Advanced                                      | Opens these file types  |
|                                                                  | [.mkv] [.mp4] Manage    |
+------------------------------------------------------------------+-------------------------+
| Unsaved changes                                    [Discard] [Save changes]   (sticky)    |
```
Edit page, phone: header, tabs scroll sideways with the active tab in view, one column, the aside cards follow the
form, sticky save bar only when dirty.

### 3.3 "Program to start" (guided exe path)

`ProgramPathInput` (in `screens/apps/desktop/ProgramPathInput.tsx`): a `Select` of roots (Program Files ->
`{ProgramFiles}\`, Program Files (x86) -> `{ProgramFilesX86}\`, Windows System32 -> `{SystemRoot}\System32\`) plus a
text input for the rest (`VideoLAN\VLC\vlc.exe`). The value is the same `exe` string; `v.exePath` validates inline.
Pre-fill order: gallery `exe`; winget `defaultInstallLocation` (folder only, focus lands after the last `\`); the
detected `companyName`/`productName` as a hint line ("Usually under Program Files\<company>"). Shown collapsed as
"Starts <path> [Change]" when filled, expanded and required when empty. Portable: hidden (fixed path).

## 4. Layout per band

| Screen | 390 phone | 820 tablet | 1366 laptop | 1920 wide |
|---|---|---|---|---|
| Start / gallery | 1 col; search full width; chips scroll sideways; grid 2 cols (container query, min card 150 px); "Other ways" as list rows below | grid 3-4 cols; "Other ways" as 2 cards in a row below the grid | `dash-split`: grid 4 cols (main) + "Other ways" aside, sticky | max 1480; grid 6 cols; aside stays 1/3 |
| Windows review | 1 col; status lines in the main card; sticky bottom Add bar | 1 col max 680 px centred; summary card above the form | `dash-split`: form main + sticky summary aside with the Add button | same, `dash-form-grid` puts name + description side by side |
| Own installer | 1 col; link field then results | 1 col max 680 | split: form + aside (what was found, Add) | same |
| Website | 1 col; preview after the picker, collapsed to a summary line that expands; sticky Add | 1 col; preview as 2 columns (Opens / Blocked) under the picker | split: form main + sticky preview aside with Add | same; picker levels and chips in one row |
| Edit: Details | 1 col; aside cards after the form; sticky save bar when dirty | 1 col; aside cards in a 2-col grid below | `dash-split` form + facts aside | same, form grid 2 cols |
| Edit: Who gets it | table as cards (existing DataTable phone mode); Assign button full width | table | table + aside "Also given directly to n employees" | same |
| Edit: Installs | state buttons wrap, list as cards | list table | state buttons as a vertical list (aside) + table main | same |
| Edit: Updates / Permissions | 1 col | 1 col | 2 cols: mode + fields main, feed status / blocked counts aside | same |

Page CSS: `src/screens/apps/apps.css` (start, review, edit) and `src/screens/apps/web/siteAccess.css`, imported by
the lazy screens. Entrance: `dash-enter` (opacity/transform), none on tab switches; reduced motion and Lite honoured.

## 5. Silent-mode automation

`src/lib/apps/silentMode.ts` (pure): `silentStatus(input) -> { state, tone, label, info }`, used by the review and the
Details tab. Input: source, install kind, tech, confidence, current switches, the automatic switches, needsAnswerFile,
answerOn.

| Installer (detected or winget) | Saved as | Switches saved (automatic) | Success codes | UI line | (i) text |
|---|---|---|---|---|---|
| MSI (OLE magic) / winget `msi`, `wix` | `kind: msi` | none (the agent runs msiexec quietly) | 0 (+ manifest codes) | Installs silently | "A Windows Installer package. Rulebox installs it in the background; nobody has to click anything." |
| winget `exe`/`inno`/`nullsoft`/`burn` with `InstallerSwitches.Silent` | `kind: exe` | the manifest's switches | manifest | Installs silently | "Uses the silent switches published in the winget catalogue." |
| winget `inno` / `nullsoft` / `burn` without switches | `kind: exe` | `DEFAULT_SILENT` (Inno 4 switches, `/S`, `/quiet /norestart`) | manifest | Installs silently | same |
| winget `msix`, `appx`, `zip`, `portable`, plain `exe` without `Silent`, or `Scope: user` only | refused (`winget_unsupported`) | - | - | error sentence | "This app can't be installed silently for everyone" + website fallback if any |
| NSIS (high/medium) | exe, `tech: nsis` | `/S` | 0 | Installs silently | "An NSIS installer: Rulebox runs it with /S." |
| NSIS + `asInvoker` (`perUserLikely`) | exe, nsis | `/S` (Tier A `/D={InstallDir}` offered under Advanced) | 0 | Installs silently + warning "may install for one account only; try it on one PC first" | per-user text |
| Inno Setup (high/medium) | exe, inno | `/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | 0 | Installs silently | "An Inno Setup installer." |
| WiX Burn bundle (high) | exe, burn | `/quiet /norestart` | 0, 3010, 1641 | Installs silently | "A WiX bundle. A restart request counts as done." |
| WiX Burn (low, `description=wix`) | exe, burn | same | same | Installs silently (best guess) | warning "try it on one PC first" |
| InstallShield with MSI inside (low) | exe, installshield_msi | `/s /v/qn` | 0, 3010, 1641 | Installs silently (best guess) | same warning |
| InstallShield Script (low) | exe, installshield_script | `/s /f1{AnswerFile}` | 0 | blocking notice "Needs a recorded answer file" -> opens Advanced; Add disabled until the file is given | the existing answer-file help |
| Advanced Installer (low) | exe, advanced_installer | `/exenoui /qn /norestart` | 0, 3010, 1641 | Installs silently (best guess) | warning |
| Plain EXE, nothing recognised | exe, no tech | none | 0 | warning card "Rulebox can't tell how this installer runs silently" (Section 3.2); Add disabled until switches exist (`v.silentArgs` requires them) | "Ask the vendor. A wrong switch makes the installer wait for a click; the PC stops it after 30 minutes and shows 'needs interaction'." |
| Portable | portable | - | - | No install needed | "Rulebox copies the program to the PC and checks it." |
| Already on the PCs | preinstalled | - | - | Nothing to install | "Rulebox only starts it." |
| Admin changed the switches | (as typed) | as typed | as typed | Installs with your own switches | "Use automatic" button restores the computed switches |

**Advanced override** ("Install command" group inside Advanced): installer type (`Select`, tech), silent switches
(with "(edited)" and "Use automatic"), success codes, timeout, expected signer + "Use <signer>", answer file, MSI
product code, installer link and fingerprint (read-only + "Change"), winget version ("Choose another version").
The pre-fill rule of `installerPrefill.ts` is kept: automation never overwrites text the admin typed; typed text
marks the line "own switches". Confidence low -> warning tone, never silence. Server validation is unchanged.

**Detection for a link** (new, D8): `apps:fingerprintInstaller({ url })` streams the file once (reuse
`convex/lib/feed/fetch.ts` with `onChunk`), keeps the first 2 MiB (`INSPECT_HEAD_BYTES`), the certificate table
range (known from the head, captured while streaming, <= 256 KiB) and the last 64 KiB in a ring buffer, hashes all
bytes (SHA-256), then runs `detectInstaller`. Returns `{ sha256, sizeBytes, inspection | null }`. Cap 512 MiB
(`FEED_INSTALLER_MAX_BYTES`); larger files fall back to `apps:inspectInstaller` (type) + the local file check (hash).
Trust note (plan only, not UI): the hash comes from the same place as the file (trust on first use); it pins the file
so a later swap is refused by the PC. The winget path keeps the manifest's hash (an independent source).

## 6. `SiteAccessPicker` (subdomains as an interactive example)

Files: `src/screens/apps/web/SiteAccessPicker.tsx`, `src/screens/apps/web/siteAccess.css`, pure logic
`src/lib/apps/siteAccess.ts`, data `src/lib/apps/publicSuffixes.ts`, display helper `src/lib/apps/punycode.ts`.

**Data model, unchanged:** `allowedDomains: string[]` sent to `apps:createWeb` / `apps:update`, the address's host
excluded (the server prepends it). The form field changes from a textarea string to `domains: string[]`
(`FormValues`); `v.domains` keeps validating. The picker writes **plain entries only** (`example.com`, never `*.`),
because a plain entry already includes all subdomains in both modes (D12). Existing `*.x` entries are kept as they
are, shown as "x and everything under it" with a small "(*)" note (see D28).

**Props**
```ts
interface SiteAccessPickerProps {
  url: string;                    // the form's address, may be invalid or empty
  value: string[];                // extra entries
  onChange(next: string[]): void;
  isNew: boolean;                 // enables the www default (D14)
  browser?: BrowserKind;          // Edge/Chrome: preview footnote about the shared list
  suggestions?: SiteSuggestion[]; // sign-in services; gallery entries add their own
  error?: string;                 // inline (client) or server `allowedDomains` refusal
  disabled?: boolean;             // viewer / archived
  id?: string; "aria-describedby"?: string;
}
type SiteSuggestion = { label: string; entries: string[] }; // "Microsoft sign-in": ["login.microsoftonline.com", "login.live.com"]
```

**Pure functions** (`siteAccess.ts`): `parseAddress(url) -> { host, port, path, isIp } | null`;
`registrableDomain(host)`; `levels(host) -> string[]` (host first, then each parent down to the registrable domain,
max 4; an IP or a single-level host gives one); `selectedLevel(host, entries)`; `withLevel(host, entries, level)`
(removes entries equal to any level of this host, adds `level` first unless it is the host); `normalizeEntry(text)`
(accepts `https://Login.Example.com/x`, `login.example.com`, Unicode; returns lower-case ASCII host or a reason:
`port`, `local`, `suffix`, `ip_private`, `format`); `allows(address, url, entries)` (mirror of `allow.rs`: https only,
no credentials, port equality, IP exact, label-suffix match, `*.x` treated as x); `samples(url, entries)`.

**Registrable domain without the big list:** longest match in a small bundled list (~100 entries: common
second-level ccTLD suffixes `co.uk, org.uk, ac.uk, gov.uk, com.au, net.au, org.au, co.nz, co.jp, ne.jp, or.jp,
com.br, com.cn, com.mx, co.in, co.za, com.sg, com.my, com.pk, com.tr, com.sa, com.eg, co.kr, com.hk, com.tw, ...`
and private hosting suffixes where siblings belong to other owners: `github.io, sharepoint.com, onmicrosoft.com,
azurewebsites.net, cloudfront.net, herokuapp.com, vercel.app, netlify.app, pages.dev, workers.dev, web.app,
firebaseapp.com, appspot.com, blogspot.com, myshopify.com, wixsite.com, wordpress.com, onrender.com, fly.dev, ...`)
plus one rule for everything else: when the TLD has 2 letters and the label before it is one of `co, com, net, org,
gov, edu, ac, or, ne, go, gob, nic, mil, ltd, plc`, both labels are the suffix. Otherwise the last label is the
suffix. The registrable domain is suffix + one label. The picker never offers a level that is a suffix, and
`normalizeEntry` refuses a typed suffix (`co.uk`, `github.io`, `sharepoint.com`): "That would allow every site ending
in .co.uk. Add the full site name." (client only, D15). ~1.5 KB gzip, in the website chunk only.

**Interaction and rendering**
- The address is drawn as `https://` + one chip per level-part (`shop` . `example.com`) + the path, muted.
  The allowed part is highlighted (accent underline across the covered labels). Clicking a part selects its level.
  This drawing is `aria-hidden`; the real control is the radiogroup below it.
- Radiogroup "Which pages open": "Only shop.example.com" / "All of example.com" (hint: "also mail.example.com,
  www.example.com and the rest"). Deeper hosts show up to 4 levels. One level only (host is the registrable domain
  or an IP): no radios, the sentence "example.com and everything under it opens" (IP: "Only this address opens").
- "Other sites it needs": chips (entry + remove button), suggestion toggle buttons (`aria-pressed`) for "Microsoft
  sign-in" and "Google sign-in" (plus gallery-provided ones), an "Add a site" input + Add button (Enter adds; paste
  of a full URL is reduced to its host). An entry already covered by the chosen level is shown muted "(already
  included)"; nothing is removed silently. At 20 entries the input is disabled with "Up to 20 other sites."
- Preview "What employees can open": `samples()` gives at most 7 rows, each "address - Opens/Blocked - reason":
  the start page; another page of the site; a sub-address (`login.<host>`); a sibling (`mail.<registrable>`, first of
  mail/shop/www not equal to the host's first label) and the bare registrable domain when host != registrable; up to
  3 extra entries; another website (`www.wikipedia.org`, or `www.google.com` when the site is Wikipedia); the
  `http://` form ("not secure"). "Try an address" input answers instantly with the same `allows()`.
  Browser mode footnote: "In Edge or Chrome, all browser websites on a PC share one list." Path note when the
  address has a path: "Every page of the site opens, not only /start."
- States: no address / invalid (picker hidden, one muted line), IP host, single level, many levels, at max, read-only
  (radios disabled, chips without remove, no add input), error (inline under the picker, `aria-invalid`).

**Keyboard and screen readers:** radiogroup with roving tabindex (arrows, Home/End); chips: one Tab stop per
remove button, `aria-label="Remove accounts.google.com"`, focus moves to the next chip or the input after removal;
suggestions are `button[aria-pressed]`; the add input has a label and `aria-describedby` for the rule and error; the
preview is a `<ul>` with text "mail.example.com, opens"; one `aria-live="polite"` line announces "5 open, 2 blocked"
after changes (debounced 500 ms); the drawn address chips are mouse/touch shortcuts only (`tabIndex=-1`,
`aria-hidden`), so nothing is reachable only by pointer.

**Examples and edge cases**

| Address | Levels offered | Default (new) | Notes |
|---|---|---|---|
| `https://shop.example.com/start` | shop.example.com, example.com | Only shop.example.com | choosing example.com writes `["example.com"]` |
| `https://www.example.com/` | www.example.com, example.com | All of example.com (D14) | avoids blocking `example.com` redirects |
| `https://example.com/` | one | - | "example.com and everything under it opens" |
| `https://a.b.example.co.uk/` | a.b.example.co.uk, b.example.co.uk, example.co.uk | host | never `co.uk` |
| `https://contoso.sharepoint.com/` | one | - | `sharepoint.com` is a suffix: never offered |
| `https://203.0.113.5/` | one | - | "Only this address"; extras that are public IPv4 stay exact matches |
| `https://shop.example.com:8443/` | host, example.com | host | preview shows `example.com` opens on 443 only; extras can't carry ports (validation) |
| `https://bücher.de/` (stored `xn--bcher-kva.de`) | one | - | shown as bücher.de (punycode decoded for display, ASCII in `title`) |
| `localhost`, `x.local`, `foo.localhost`, `192.168.1.10` typed as extra | refused client-side ("on the local network") | | the server accepts some of these today (Section 10) |
| `co.uk`, `github.io` typed as extra | refused ("every site ending in...") | | |
| `https://login.example.com/x` pasted as extra | becomes `login.example.com` | | port pasted -> "Ports can't be added here" |

## 7. Popular apps gallery

Files: `src/screens/apps/gallery/catalog.ts` (data, typed), `src/screens/apps/gallery/GalleryGrid.tsx`,
`src/screens/apps/gallery/logos/` (empty in v1), `src/screens/apps/gallery/catalog.test.ts`.

```ts
export type GalleryCategory = "browsers" | "meetings" | "office" | "media" | "tools";
export interface GalleryApp {
  key: string;                 // URL-safe, `?gallery=<key>`
  name: string;                // saved as the app name
  blurb: string;               // 3-6 words
  category: GalleryCategory;
  hue: number;                 // letter-tile colour, one of HUES
  logo?: string;               // bundled file in logos/; absent = letter tile (all absent in v1)
  kind: "desktop" | "web";
  wingetId?: string;           // desktop + winget
  source?: "winget" | "preinstalled";
  exe?: string;                // path template; `v.exePath` must pass (test)
  warning?: "unrestricted_browser";
  sites?: string[];            // Chrome/Edge: starter browser rules (none in v1: the admin adds them)
  url?: string; allowedDomains?: string[]; permissions?: Partial<WebPermissions>; // web
  verified: boolean;           // exe path / domains confirmed on the VM
}
```

Curated list (IDs confirmed in `winget-pkgs` 2026-11-28 with their newest installer type; exe paths are typical
machine-wide locations and are **unverified** until the VM check, Step 17):

| Key | Name | Category | Kind / winget ID | Installer type (newest) | Program to start | Icon |
|---|---|---|---|---|---|---|
| chrome | Google Chrome | browsers | winget `Google.Chrome` | wix (MSI) | `{ProgramFiles}\Google\Chrome\Application\chrome.exe` | letter |
| edge | Microsoft Edge | browsers | preinstalled (`Microsoft.Edge` exists, msi; Edge ships with Windows) | - | `{ProgramFilesX86}\Microsoft\Edge\Application\msedge.exe` | letter |
| firefox | Firefox | browsers | winget `Mozilla.Firefox`, warning | nullsoft, `/S /PreventRebootRequired=true` | `{ProgramFiles}\Mozilla Firefox\firefox.exe` | letter |
| zoom | Zoom Workplace | meetings | winget `Zoom.Zoom` | msi, machine | `{ProgramFiles}\Zoom\bin\Zoom.exe` | letter |
| teams | Microsoft Teams | meetings | **web** `https://teams.microsoft.com/` + `login.microsoftonline.com`, `login.live.com`; camera, mic, screen share, notifications on | winget is MSIX only | - | letter |
| slack | Slack | meetings | **web** `https://app.slack.com/` + level `slack.com` | winget is `Scope: user` only | - | letter |
| outlook | Outlook (web) | meetings | **web** `https://outlook.office.com/` + `login.microsoftonline.com`, `login.live.com`; notifications on | - | - | letter |
| libreoffice | LibreOffice | office | winget `TheDocumentFoundation.LibreOffice` | msi | `{ProgramFiles}\LibreOffice\program\soffice.exe` | letter |
| onlyoffice | ONLYOFFICE | office | winget `ONLYOFFICE.DesktopEditors` | inno | `{ProgramFiles}\ONLYOFFICE\DesktopEditors\DesktopEditors.exe` | letter |
| reader | Adobe Acrobat Reader | office | winget `Adobe.Acrobat.Reader.64-bit` | exe `-sfx_nu /sAll /rs /msi` | `{ProgramFiles}\Adobe\Acrobat DC\Acrobat\Acrobat.exe` | letter |
| sumatra | SumatraPDF | office | winget `SumatraPDF.SumatraPDF` | exe `-s` (also portable) | `{ProgramFiles}\SumatraPDF\SumatraPDF.exe` | letter |
| foxit | Foxit PDF Reader | office | winget `Foxit.FoxitReader` | exe `/quiet`, wix | `{ProgramFiles}\Foxit Software\Foxit PDF Reader\FoxitPDFReader.exe` | letter |
| thunderbird | Thunderbird | office | winget `Mozilla.Thunderbird` | nullsoft | `{ProgramFiles}\Mozilla Thunderbird\thunderbird.exe` | letter |
| vlc | VLC media player | media | winget `VideoLAN.VLC` | nullsoft, wix | `{ProgramFiles}\VideoLAN\VLC\vlc.exe` | letter |
| irfanview | IrfanView | media | winget `IrfanSkiljan.IrfanView` | exe `/silent` | `{ProgramFiles}\IrfanView\i_view64.exe` | letter |
| paintnet | Paint.NET | media | winget `dotPDN.PaintDotNet` | wix | `{ProgramFiles}\paint.net\paintdotnet.exe` | letter |
| gimp | GIMP | media | winget `GIMP.GIMP.3` (`GIMP.GIMP` also exists) | inno | `{ProgramFiles}\GIMP 3\bin\gimp-3.exe` (least sure) | letter |
| audacity | Audacity | media | winget `Audacity.Audacity` | wix, loc `%ProgramFiles%\Audacity 4` | `{ProgramFiles}\Audacity 4\Audacity.exe` | letter |
| inkscape | Inkscape | media | winget `Inkscape.Inkscape` | nullsoft, wix | `{ProgramFiles}\Inkscape\bin\inkscape.exe` | letter |
| 7zip | 7-Zip | tools | winget `7zip.7zip` | exe `/S`, wix | `{ProgramFiles}\7-Zip\7zFM.exe` | letter |
| notepadpp | Notepad++ | tools | winget `Notepad++.Notepad++` | nullsoft, wix | `{ProgramFiles}\Notepad++\notepad++.exe` | letter |
| keepassxc | KeePassXC | tools | winget `KeePassXCTeam.KeePassXC` | wix | `{ProgramFiles}\KeePassXC\KeePassXC.exe` | letter |

Left out on purpose: remote-control tools (TeamViewer, AnyDesk: they bypass the kiosk), Store/MSIX-only apps,
Microsoft 365 desktop (Click-to-Run needs the Office Deployment Tool), Webex (exe path unknown; `Cisco.Webex` exists,
add later). `Zoom.Zoom.EXE` is per-user: the gallery uses `Zoom.Zoom` (MSI).

**Icons.** v1 = letter tiles for all 22 (`AppGlyph` with the entry's hue): the logos are trademarks of Google,
Microsoft, Mozilla, Zoom, Salesforce/Slack, Adobe, VideoLAN, TDF and others, and their guidelines generally restrict
use of the logo itself (names may be used to refer to the product). None was confirmed to allow bundling in a
product UI, so none is bundled. App names stay; a footer line says "App names are trademarks of their owners.
Rulebox is not affiliated with them." **Adding a logo later:** owner checks that vendor's brand terms, adds an SVG
(<= 4 KB, optimised, no external refs) or 64 px WebP to `gallery/logos/<key>.svg`, sets `logo`, adds a line to
`THIRD_PARTY_NOTICES.md` (source, terms link, date), and `catalog.test.ts` checks every `logo` file exists and is
under the size cap. Logos are imported with `?url` from the lazy chunk, so they never reach the entry bundle.

**Lazy loading.** `catalog.ts` and `GalleryGrid` live only in the `AddAppStart` chunk (target <= 8 KB gzip with
22 entries); `DesktopAdd` and `WebAppForm` import `catalog.ts` too (a shared ~1 KB chunk Vite splits out). The edit
page never loads it. The search filters the bundled list in the browser: it is static data shipped with the code,
not database rows, so the "search on the server" rule does not apply.

**One click -> create.** Card click navigates to `?kind=desktop&gallery=<key>` (or `kind=web`). Desktop:
`DesktopAdd` calls `resolveWinget({ packageId })` once on mount (ref-guarded for StrictMode; served from
`wingetCache` when anyone resolved it in the last 24 h), and `apps:byWinget` checks for a duplicate. The form is
filled: name and hue from the entry, `resolved` from the answer, `exe` from the entry, `removeWhenUnassigned` from
the answer, `version` = resolved version, update mode Keep (browsers: forced vendor). "Add" sends the existing
`apps:createDesktop` payload (`desktopSpec()` unchanged). Preinstalled (Edge): no resolve, source `preinstalled`.
Web: prefilled `url`, `allowedDomains`, name, hue; "Add" calls `apps:createWeb`, then, when the entry has
`permissions`, `apps:setPermissions` once (the new app has no groups yet, so it publishes nothing; D22).

## 8. Data

| Function | Change | Reads per run | When it runs |
|---|---|---|---|
| `apps:get` | none | unchanged (budget line 220) | edit page, once for all tabs |
| `apps:installSummary`, `apps:installs` | none | unchanged | **only on the Installs tab** (today: every desktop edit page) |
| History query (`HistoryPanel`) | none | unchanged | **only on the Activity tab** (today: always) |
| `apps:options` | none | unchanged | only while Chrome is picked |
| `apps:createDesktop`, `apps:createWeb`, `apps:update`, `apps:setPermissions`, `groups:assignApp` | none | unchanged | on Add / Save |
| `apps:resolveWinget` | none | 2 cached / 8 uncached | once per review page open |
| `apps:fetchWebMeta` | none (auto-run on blur/Enter, once per distinct address) | 6 | website form |
| `apps:inspectInstaller` | none; fallback for files > 512 MiB | 6 | rare |
| **`apps:fingerprintInstaller`** (new action, admin) | `convex/lib/installerFingerprint.ts` (pure head/cert/tail capture + hash over `feed/fetch.ts`), rate limit `installerFingerprint` 10/h per org, errors `invalid_argument` field `url` detail `fingerprint_too_large` / `fingerprint_blocked` / `fingerprint_failed` / `fingerprint_not_installer` | rate-limit row only (~6) | once per pasted link |
| **`apps:byWinget`** (new query, viewer) | index `apps.by_org_winget: ["orgId", "desktop.wingetId"]`, `.withIndex(...).take(1)`, returns `{ _id, name, archived } \| null` | 3 auth + 1 | review page only (live, but its index range changes only when such an app is added) |

`convex/ioBudgets.ts` entries: `"apps:fingerprintInstaller": { maxReads: 6, maxReadBytes: 4_096, maxWrites: 1,
maxWriteBytes: 512 }`, `"apps:byWinget": { maxReads: 3 + 1, maxReadBytes: 6_144, maxWrites: 0, maxWriteBytes: 0,
live: true }`. Net effect: opening a Windows app's page no longer runs the install summary (up to 3+1+500+5x1,001
reads) or the history query unless those tabs are opened.

Data seam (`src/data/api.ts` + demo + live, `src/data/README.md` rows):
- `useFingerprintInstaller: Mutation<{ url: string }, { sha256: string; sizeBytes: number; inspection: InstallerInspection | null }>`;
  demo twin derives tech from words in the URL like `useInspectInstaller`, `big` in the URL -> too large.
- `useAppByWinget(packageId | "skip"): QueryState<{ _id; name; archived } | null>`; demo searches the in-memory apps.
- Demo `useResolveWinget` knows every gallery ID (fixture in `src/data/demo/wingetFixtures.ts`, versions and kinds
  from Section 7; Teams/Slack answer `winget_unsupported` like the live server). Must not reach the live build
  (`forbiddenStrings` stays green).
- Types: `FormValues.domains: string[]`; `FingerprintResult` in `src/data/types.ts`.

## 9. Strings (new or changed; `appAdd.ts`, `appSiteAccess.ts`, edits to `appEdit.ts`, `appInstaller.ts`, `appUpdates.ts`, `apps.ts`)

| Key | Text | (i) text |
|---|---|---|
| apps.add | Add app | - |
| start.title / lead | Add an app / Pick a popular app, or add a website or your own installer. | - |
| start.search | Search, or paste a website address | - |
| start.addSite / lookUp | Add the website {host} / Look up {id} in the winget catalogue | winget: "Microsoft's public list of Windows apps. Rulebox reads it on the server; PCs download from the publisher." |
| start.categories | All, Browsers, Meetings and chat, Office and PDF, Photos, video and sound, Tools | - |
| start.otherWays | Other ways to add: Website or web app / Your own installer / Already on the PCs / A single program file | own installer: "An .exe or .msi file at an https:// link." |
| start.noMatch | No popular app matches. Paste a website address or a winget ID. | - |
| start.trademarks | App names are trademarks of their owners. Rulebox is not affiliated with them. | - |
| review.title / add | Add {name} / Add {name} (busy: Adding...) | - |
| line.silent | Installs silently | "Rulebox installs it in the background on each PC. Nobody has to click anything." + per-type sentence (Section 5) |
| line.guess | Installs silently (best guess) | "Rulebox recognised the installer type but isn't certain. Try it on one PC first." |
| line.own | Installs with your own switches | "You changed the install command in Advanced. Use automatic to go back." |
| line.checked | Checked before it installs | "Each PC checks the file's fingerprint and refuses a file that has changed." |
| line.winget | From the winget catalogue, version {v} | winget text above |
| line.remove / keep | Removed from PCs when you take it away / Stays installed when you take it away | "EXE installers can't be uninstalled automatically, so the app is only hidden." |
| line.version | Keeps version {v} [Change] | update-mode text below |
| unknown.title / body | Rulebox can't tell how this installer runs silently. / Ask the vendor for its silent switches and enter them in Advanced. | "A wrong switch makes the installer wait for a click. The PC stops it after 30 minutes and shows 'needs interaction'." |
| answer.needed | This installer needs a recorded answer file. | existing answer-file help (moves to (i)) |
| program.label / hint | Program to start / Where the app's .exe is after it installs. | "Rulebox starts this file when an employee opens the app." |
| program.roots | Program Files / Program Files (x86) / Windows System32 | - |
| installer.link / file | Installer link / I have the file | link: "PCs download the installer from here. It must start with https://." file: "Reads the file in this browser to check it. Nothing is uploaded." |
| installer.checking | Checking the installer... This can take a minute for a big file. | - |
| installer.found | Checked: {product} {version}, {type}, {size} | - |
| installer.tooBig | This file is too big to check online. Choose the same file on this computer. | - |
| dup | {name} is already in your apps. [Open it] | - |
| unsupported.msix / user / noSilent | {name} can't be installed by Rulebox: it's a Store-style package. / ...it only installs for one user account. / ...it has no silent install. | - |
| unreachable | The app catalogue can't be reached right now. Try again in a minute. | - |
| web.address | Website address (placeholder example.com) | "The page employees see first." |
| web.fetching / fetchFailed | Getting the name and icon... / Couldn't read the site's name and icon. Type a name. | - |
| access.label | Which pages open | "Employees can open this site and everything under it. Choose how much of the site, and add other sites it needs, such as a sign-in page." |
| access.only / all / allHint | Only {host} / All of {domain} / also {a}, {b} and the rest | - |
| access.single / ip | {domain} and everything under it opens / Only this address opens | - |
| access.others | Other sites it needs | "Sign-in pages and payment pages are often on another site." |
| access.suggest | Microsoft sign-in / Google sign-in | - |
| access.add | Add a site (placeholder login.example.com) / Add | - |
| access.errSuffix / errLocal / errPort / errMax / included | That would allow every site ending in .{s}. Add the full site name. / That address is on the local network. / Ports can't be added here. / Up to 20 other sites. / (already included) | - |
| preview.title / open / blocked | What employees can open / Opens / Blocked | - |
| preview.reasonHttp / other | not secure / another website | - |
| preview.try / summary | Try an address / {n} open, {m} blocked | - |
| preview.browserNote / pathNote | In Edge or Chrome, all browser websites on a PC share one list. / Every page of the site opens, not only {path}. | - |
| more / advanced | More options / Advanced | - |
| tabs | Details, Who gets it, Installs, Updates, Permissions, Activity | - |
| saveBar | Unsaved changes / Save changes / Discard | - |
| added | {name} added. Choose who gets it. [Assign to a group] | - |
| update modes | Keep this version / The app updates itself / Rulebox updates it | pinned: "PCs keep the version you added until you change it." vendor: "The app's own updater keeps it current." managed: "Rulebox checks the vendor's update feed and installs new versions for you." |
| firefox warning | Firefox can open any website. Rulebox limits websites only in Chrome and Edge. | - |
| browser rules | Sites this browser may open (chips) / Without any, the browser only shows its blocked page. | - |

Technical labels inside Advanced keep today's wording (they are for people who know them), each long hint moves to
`info`.

## 10. Edge cases, roles, errors

- **Roles:** viewer: start page browsable, cards and other ways disabled, read-only notice; edit page read-only, no
  save bar, Assign/Retry/Archive hidden (RoleGate). Admin and Owner: everything. Direct URL `?gallery=x` as viewer:
  review shows the read-only notice, no resolve call (actions are admin-only on the server anyway).
- **Unknown `gallery` key or bad `winget` ID in the URL:** back to the start page with "That app isn't in the list."
- **Gallery entry resolves to another installer kind** (7-Zip may come back as wix MSI): silent mode follows the
  answer, not the catalogue.
- **Gallery exe path wrong on a real PC:** the PC reports `exe_missing_after_install`; the Installs tab shows it and
  Details -> Program to start fixes it (a save publishes the fix). The VM check (Step 17) prevents this.
- **winget refusals:** `winget_unsupported` details mapped to the three plain sentences; `winget_unreachable` -> retry
  sentence (GitHub rate limit; `GITHUB_TOKEN` hint stays in the operator log, not the UI); `rate_limited` -> "Too many
  lookups. Wait a minute."
- **Fingerprint refusals:** too large -> local file path; blocked (private host, http) -> "PCs need a public https://
  link."; failed / timeout -> "Couldn't download the installer. Check the link."; not an installer -> "That file is
  not a Windows installer (.exe or .msi)." Changing the link after a check clears the result (hash, switches) unless
  typed by the admin.
- **Local file differs from the checked link** -> "This file is different from the one at the link" (existing
  `hashDiffers` sentence), nothing changes.
- **Plain EXE with no switches:** Add disabled with the reason inline; never a guessed switch saved silently.
- **InstallShield Script:** Add disabled until the answer file link and fingerprint are given.
- **Per-user NSIS:** warning; Tier A `{InstallDir}` offered as an Advanced one-click ("Install into Program Files").
- **Plan limit** (`plan_limit` detail `apps`) on Add: inline "Your plan allows {n} apps. Archive one or upgrade."
- **Duplicates:** allowed after the notice (two configs of one app can be intended).
- **Website:** the www default only for new apps; editing never changes saved entries until the admin changes the
  picker. A saved `*.x` entry is shown and kept. An address change keeps extras; the level radios follow the new
  host (old level entries of the old host stay as chips). IDN stored as punycode. Server `allowedDomains` refusal
  shown under the picker.
- **Gaps found (not fixed here, follow-ups):** (1) built-in window and `*.x` (likely allows nothing; add a
  `step15_tests.rs` case and strip `*.` in `parse_entry`, or have the server store `x`); (2) the server accepts extras
  like `co.uk`, `foo.localhost`, `x.local` and private IPv4 (`domainProblem` checks syntax only); mirror the picker's
  refusals in `hostRules.ts` after an owner OK (it tightens validation of existing data on next save).
- **Tabs and unsaved work:** Details and Updates share one form (lifted to the page); Permissions draft lifted too;
  leaving the page with unsaved changes uses the existing unsaved hint plus a `beforeunload` guard.
- **Stale edit:** unchanged (FormError with Reload).
- **Very long names / many groups / no network to GitHub / demo mode:** truncation with `title`; assignments table
  pages client-side as today; demo answers from fixtures.

## 11. Tests

Existing tests that change:
- `src/screens/step10.test.tsx`: website tests type the address and use the picker (or Advanced -> "Edit the list by
  hand") instead of the "Allowed domains" textarea; the Windows tests go through `?kind=desktop&winget=VideoLAN.VLC`
  (auto resolve) and the program path input; Updates card tests open `?tab=updates`; assign/archive tests on
  `?tab=access`. Expected payloads stay identical (data model unchanged).
- `src/screens/step13installer.test.tsx`: Detect/Check-a-file move under Advanced or are replaced by the automatic
  check; keep every prefill invariant (never overwrite typed text, "edited" mark, answer-file token rules) against the
  Advanced fields; add the fingerprint path.
- `src/screens/step16.test.tsx`: Opens in under "More options"; browser rules use the chip editor (raw list under
  Advanced); permissions tests on `?tab=permissions`.
- `src/screens/step17.test.tsx` (install status) -> `?tab=installs`, and a new assertion that the summary/installs
  queries are not called on the Details tab.
- `src/screens/feedActions.test.tsx` -> `?tab=updates`.
- `src/screens/lists4b.test.tsx` / step10 list test: one "Add app" link to `/apps/new`.
- `src/app/route-table.test.ts`: `/apps/new` still maps to `["Layout", "AppEdit"]` (the shell), lazy chunks listed.
- `src/lib/apps/installerRules.test.ts`: unchanged (rules are reused); `src/data/demo/demo.test.tsx`,
  `src/data/live/live.test.tsx`: new hooks.
- `convex/ioBudgets.test.ts`: the two new entries; `convex/apps.test.ts`: `byWinget`; `convex/schema` index.
- Note: `step13.test.tsx`, `step14.test.tsx`, `step14b.test.tsx` are Networks/printers/drivers tests and do not change.

New tests:
- `src/lib/apps/siteAccess.test.ts`: levels, registrable domain (list + heuristic, `co.uk`, `sharepoint.com`, unknown
  `co.xx`), `withLevel`/`selectedLevel` round trips, `normalizeEntry` reasons, `allows()` against every vector of
  `apps/staff-app/src-tauri/src/step15_tests.rs` (copied by hand with a comment pointing at the file), `*.x`, ports,
  IPs, punycode, `samples()` shape (<= 7 rows).
- `src/lib/apps/silentMode.test.ts`: every row of Section 5.
- `src/screens/apps/gallery/catalog.test.ts`: unique keys, `v.wingetId` passes, `v.exePath` passes, web entries pass
  `v.webUrl` and `v.domains`, hues in HUES, categories valid, logo files exist and <= 4 KB, 16-24 entries.
- `src/screens/apps/web/SiteAccessPicker.test.tsx`: keyboard (arrows, Enter adds, remove moves focus), ARIA roles,
  live summary, read-only, max 20, error display, `onChange` values (plain entries only).
- `src/screens/apps/addApp.test.tsx`: search rows (gallery match, website, winget), viewer disabled, card click ->
  review -> resolve once -> Add payload equals today's `createDesktop` payload for VLC; duplicate notice; unsupported
  Teams desktop never offered (web entry instead); website gallery entry -> createWeb then setPermissions.
- `src/screens/apps/appPage.test.tsx`: tabs in the URL, lazy queries per tab, shared save bar across Details and
  Updates, Permissions draft survives a tab switch, `?added=1` banner.
- `convex/installerFingerprint.test.ts`: head/cert/tail capture across chunk boundaries, hash equals one-shot
  SHA-256, cap, refusals, detection result equals `detectInstaller` on the whole file (committed test vectors only,
  no network).

## 12. Build steps

Each step is one Sonnet agent, small, with its tests. Waves can run in parallel; within a wave the steps touch
different files. Shared components (`Select`, `SearchSelect`, `InfoTip`, `Field info`, `PageTabs`/`useUrlTab`, layout
classes) come from `foundations.md`; until they land, code against the contract names.

| Step | Files | Depends on | Wave |
|---|---|---|---|
| 1. Move the form model out of the screen (no UI change): `FormValues`, `initialValues`, `validateValues`, `desktopSpec`, `updateSpec`, `effectiveMode`, `nearestHue`, `HUES` into `src/screens/apps/appForm.ts`; `AppInstaller/AppBrowser/AppUpdates` import types from there; all tests green | `screens/AppEdit.tsx`, new `screens/apps/appForm.ts`, 3 importers | - | 1 |
| 2. `siteAccess.ts`, `publicSuffixes.ts`, `punycode.ts` + `siteAccess.test.ts` | `src/lib/apps/*` | - | 1 |
| 3. `silentMode.ts` + test | `src/lib/apps/silentMode.ts` | - | 1 |
| 4. Gallery data: `catalog.ts` + `catalog.test.ts` + empty `logos/` | `src/screens/apps/gallery/` | - | 1 |
| 5. Convex fingerprint: `convex/lib/installerFingerprint.ts`, `apps:fingerprintInstaller`, rate limit, ioBudgets, tests (`pnpm test:convex`) | `convex/` | - | 1 |
| 6. Convex `apps:byWinget` + index + ioBudgets + tests | `convex/schema.ts`, `convex/apps.ts`, `convex/ioBudgets.ts` | - (after 5 if the same agent edits `apps.ts`/`ioBudgets.ts`; else serialize 5 then 6) | 1b |
| 7. Strings: `appAdd.ts`, `appSiteAccess.ts`, edits to `appEdit.ts`, `appInstaller.ts`, `appUpdates.ts`, `apps.ts` | `src/lib/screenStrings/` | - | 1 |
| 8. Data seam: `useFingerprintInstaller`, `useAppByWinget`, demo fixtures for all gallery IDs, live hooks, README rows, demo/live tests | `src/data/*` | 4, 5, 6 | 2 |
| 9. `SiteAccessPicker` + css + test | `src/screens/apps/web/` | 2, 7 | 2 |
| 10. Start page: `AddAppStart.tsx`, `GalleryGrid.tsx`, `apps.css` (start section), smart search | `src/screens/apps/` | 4, 7 | 2 |
| 11. Edit page shell: `AppPage.tsx` with PageTabs, lifted form + save bar, tabs `DetailsTab`, `AccessTab` (moved `AssignmentsCard`/`AssignToGroup`), `InstallsTab` (moved `InstallStatus`), `UpdatesTab` (wraps `AppUpdates`), `PermissionsTab` (wraps `AppPermissions`, lifted draft), `ActivityTab` | `src/screens/apps/page/*` | 1, 7 | 2 |
| 12. Windows add flow: `DesktopAdd.tsx` (gallery/winget review, own installer with fingerprint, preinstalled, portable), `ProgramPathInput.tsx`, status lines component `InstallLines.tsx`, Advanced group (reuses `InstallerCard`/`DetectRow` pieces) | `src/screens/apps/desktop/*`, `screens/AppInstaller.tsx` | 1, 3, 7, 8 | 3 |
| 13. Website form (new + Details tab body): `WebAppForm.tsx` with auto-fetch, picker, More options (OpensInCard), Advanced raw list; Chrome/Edge program browser-rules chip editor | `src/screens/apps/web/*`, `screens/AppBrowser.tsx` | 1, 7, 9 | 3 |
| 14. Desktop Details tab body: status lines, program path, More options, Advanced (same pieces as 12) | `src/screens/apps/page/DetailsTab.tsx` | 11, 12 | 4 |
| 15. Route shell: `AppEdit.tsx` becomes a thin switch (new: start / desktop / web by query; existing: `AppPage`), each lazy; `Apps.tsx` one "Add app"; `AppBrowser` Chrome link -> `?kind=desktop&gallery=chrome`; Overview link check | `screens/AppEdit.tsx`, `screens/Apps.tsx`, `screens/AppBrowser.tsx` | 10-14 | 5 |
| 16a. Update old suites: `step10.test.tsx`, `lists4b.test.tsx`, `route-table.test.ts` | tests | 15 | 6 |
| 16b. Update old suites: `step13installer.test.tsx`, `step16.test.tsx`, `step17.test.tsx`, `feedActions.test.tsx` | tests | 15 | 6 |
| 16c. New screen tests: `addApp.test.tsx`, `appPage.test.tsx` | tests | 15 | 6 |
| 17. Verify: typecheck + lint + all dashboard tests + `pnpm test:convex`; build + `size` (AppEdit must be <= 29.5 KB without a raise; report any needed raise with the reason); screenshots 390/820/1366/1920 light+dark of `/apps/new`, `/apps/new?kind=desktop&gallery=vlc`, `/apps/new?kind=desktop&source=installer`, `/apps/new?kind=web`, `@app`, `@app?tab=installs`, `@appWeb`, `@appWeb?tab=permissions`; fix what the shots show | - | 16 | 7 |
| 18. Owner/VM (not an agent step): add each gallery desktop entry on the VM, confirm install + start; set `verified: true`; record results in `docs/plans/phase-6-vm-results.md` | VM | 17 | later |

## 13. Decisions taken (recommended option chosen; owner reviews)

| # | Decision | Options | Taken |
|---|---|---|---|
| D1 | Entry point | (a) one "Add app" -> `/apps/new` start page; (b) keep "Website" + "Windows program" buttons | (a) |
| D2 | Gallery icons | (a) letter tiles for all, logos later per vendor terms; (b) bundle logos now | (a) |
| D3 | Gallery data | (a) static typed list in the dashboard, lazy chunk; (b) Convex table | (a): no reads, offline, reviewed in code |
| D4 | "Search for anything else" | (a) filter the curated list + exact winget ID (+ pasted winget.run/winstall/winget-pkgs URL); (b) third-party search API; (c) GitHub code search | (a); (b)/(c) need tokens or unofficial services |
| D5 | Teams and Slack | (a) gallery entries as websites; (b) leave out | (a): their winget packages are MSIX / per-user only |
| D6 | Firefox | (a) include with "can open any website" warning; (b) leave out | (a): owner named it; the warning is honest |
| D7 | Edge | (a) "Already on the PCs" with the standard path; (b) winget MSI | (a): ships with Windows |
| D8 | Installer from a link | (a) new `apps:fingerprintInstaller` (stream, hash, detect; 512 MiB; 10/h); (b) keep manual SHA-256 + Detect | (a); manual hash stays in Advanced, local file check stays |
| D9 | Unknown plain EXE | (a) block Add until switches exist, offer common-switch buttons in Advanced; (b) guess `/S` | (a): a wrong guess hangs a wizard on every PC |
| D10 | Low-confidence detection | (a) use it, "best guess, try one PC first" warning; (b) treat as unknown | (a) |
| D11 | Program path | (a) from catalogue/winget, else required guided root+path input; (b) always ask | (a) |
| D12 | What the picker writes | (a) plain entries only (`example.com`); (b) `*.example.com` | (a): same meaning in both modes, avoids the `*.` gap |
| D13 | Registrable domain | (a) ~100-entry bundled list + generic-SLD rule; (b) full public suffix list (~45 KB) | (a) |
| D14 | `www.` hosts | (a) new apps preselect "All of <domain>"; (b) only the host | (a): `example.com` redirects would be blocked otherwise |
| D15 | Suffix / local-name extras | (a) refused in the dashboard now, server mirror after owner OK; (b) server now | (a) |
| D16 | Raw allowed-domains list | (a) keep under Advanced; (b) remove | (a) |
| D17 | Fetch details | (a) automatic on blur/Enter, once per address, "Fetch again" link; (b) button only | (a) |
| D18 | Who gets it on create | (a) land on `?tab=access&added=1` with Assign; (b) group picker inside the add flow | (a): no new mutation |
| D19 | Edit tabs | (a) Windows: Details, Who gets it, Installs, Updates, Activity; website: Details, Who gets it, Permissions, Activity; default Details; (b) one long page | (a) |
| D20 | Form state | (a) lifted to the page, one save bar for Details + Updates; (b) per-tab forms | (a): both are one `apps:update` |
| D21 | Duplicate check | (a) `apps:byWinget` + index (1 read); (b) none | (a) |
| D22 | Gallery website permissions | (a) `apps:setPermissions` right after create when the entry has them; (b) leave defaults | (a): new app has no groups, nothing to publish |
| D23 | File types from the gallery | (a) not created, Manage link only; (b) auto-create handlers | (a): each `fileHandlers:set` publishes; the mapping is a deliberate choice |
| D24 | Opens in | (a) under More options; (b) up front | (a) |
| D25 | IDN display | (a) decode punycode for display, ASCII in `title`; (b) show `xn--` | (a) |
| D26 | Bundle size | (a) split AppEdit into lazy start/desktop/web/page chunks, no budget raise; (b) raise AppEdit | (a) |
| D27 | Update mode labels | (a) Keep this version / The app updates itself / Rulebox updates it; (b) Pinned / Vendor / Managed | (a) |
| D28 | `*.x` in the built-in window | (a) report as follow-up with a test to add, picker avoids `*.`; (b) fix the Staff App in this pass | (a): outside the dashboard pass |
| D29 | Viewer on `/apps/new` | (a) browsable, disabled, notice; (b) redirect to `/apps` | (a) |
| D30 | Gallery exe paths before the VM check | (a) ship with `verified: false` (no UI difference), Step 18 confirms; (b) hide unverified entries | (a) |

**PRD changes to tell the owner:** PRD 6 table "Custom installer ... silent-install flags pre-filled" becomes
"silent mode picked automatically from the detected type, the command under Advanced; the server fingerprints the
linked file (hash computed at add time)". PRD 6 "Winget app: selected from the winget catalog" gains "from a curated
popular-apps list or by ID". PRD 6.2 should state that every allowed domain includes its subdomains, and that the
`*.` form is not needed (and today likely does nothing in the built-in window).
