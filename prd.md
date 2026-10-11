\# Rulebox — Simple Kiosk OS for Windows



> \*\*Rulebox for Windows:\*\* turn any Windows PC into a locked, branded workstation.

> Your apps, your rules, your backend.



\*\*Status:\*\* Draft · \*\*Version:\*\* 0.4 · \*\*Scope:\*\* v1 = Windows, v2 = Android · \*\*License:\*\* MIT



\---



\## Table of Contents



1\. \[Overview](#1-overview)

2\. \[Concept](#2-concept)

3\. \[Architecture](#3-architecture)

4\. \[Staff App Experience](#4-staff-app-experience)

5\. \[Employee Sign-In](#5-employee-sign-in)

6\. \[App Types](#6-app-types)

7\. \[File Handling](#7-file-handling)

8\. \[Local Storage and Quotas](#8-local-storage-and-quotas)

9\. \[Core Flows](#9-core-flows)

10\. \[Desired State Model](#10-desired-state-model)

11\. \[Smart Heartbeat](#11-smart-heartbeat)

12\. \[Security and Lockdown](#12-security-and-lockdown)

13\. \[Known Edge Cases and Risks](#13-known-edge-cases-and-risks)

14\. \[Installer Compatibility Check](#14-installer-compatibility-check)

15\. \[Open Source and Generic Design](#15-open-source-and-generic-design)

16\. \[Tech Stack](#16-tech-stack)

17\. \[Roadmap](#17-roadmap)

18\. \[v2: Android Support](#18-v2-android-support)

19\. \[Out of Scope](#19-out-of-scope)

20\. \[References and Inspiration](#20-references-and-inspiration)

21\. \[Decisions](#21-decisions)

22\. \[Performance](#22-performance)

23\. \[Updates](#23-updates)

24\. \[Additional v1 Features](#24-additional-v1-features)

25\. \[Motion and Animation](#25-motion-and-animation)



\---



\## 1. Overview



Rulebox lets an administrator turn any Windows PC or laptop into a

\*\*limited, controlled workstation\*\*.



\- Employees can use only the apps, websites and files the administrator

&#x20; allows.

\- Any employee can sign in on any enrolled laptop with their own

&#x20; credentials.

\- All configuration is managed remotely from a \*\*web dashboard\*\*.

\- The administrator can return a PC to normal Windows at any time.

\- Rulebox is \*\*open source (MIT)\*\* and \*\*backend-agnostic\*\*: any

&#x20; organization can run it on its own Convex deployment.



\---



\## 2. Concept



Rulebox feels like Windows, but simpler, cleaner and fully controlled:



\- The PC starts and the \*\*Rulebox login screen\*\* appears.

\- The employee signs in and sees a branded desktop with a taskbar and a

&#x20; Start menu containing only approved apps: for example Zoom, Tally,

&#x20; company web portals and the Rulebox file explorer.

\- Apps open in real windows that can be minimized, maximized and closed,

&#x20; and appear in the taskbar while open.

\- Files such as documents, music and videos open with a double-click, just

&#x20; like in Windows.

\- The real Windows desktop, settings, browser and installers are not

&#x20; available to employees.

\- Changes made in the dashboard are applied automatically to every

&#x20; affected PC.



\---



\## 3. Architecture



Rulebox has three components.



\### 3.1 Web Dashboard (control plane)



\- \*\*Vite + React + TypeScript\*\* with a custom UI (no component library).

\- \*\*Convex\*\* for backend logic, database and real-time sync.

\- Administrator capabilities:

&#x20; - View all devices with status (online/offline, last seen, disk space)

&#x20; - Organize devices into groups (e.g. "Sales PCs", "Accounts PCs")

&#x20; - Manage employees and their access to groups, apps and storage quotas

&#x20; - Add and remove apps, websites and file handlers

&#x20; - Install apps remotely

&#x20; - Enable or disable kiosk mode

&#x20; - Configure branding (name, logo, colors, wallpaper)



\### 3.2 Agent (device-side enforcement)



\- A \*\*Windows service\*\* written in \*\*Rust\*\*.

\- Runs from boot with SYSTEM privileges and no UI.

\- Cannot be stopped or removed from the Staff account.

\- Responsibilities:

&#x20; - Maintain a live connection to Convex and receive desired-state updates

&#x20; - Create and configure the Staff Windows account during enrollment

&#x20; - Register the Staff App as the Staff account's shell

&#x20; - Install, update and remove apps silently

&#x20; - Apply lockdown policies (Section 12)

&#x20; - Manage employee folders, monitor storage quotas and clean up

&#x20;   employee sessions on logout

&#x20; - Cache the last known desired state locally for offline operation

&#x20; - Report status, disk space and results back to the dashboard



\### 3.3 Staff App (the Rulebox shell)



\- \*\*Tauri v2 + Vite + React\*\* with the same custom UI system.

\- Replaces Explorer as the shell for the Staff Windows account.

\- Provides the login screen, desktop, taskbar, Start menu, window

&#x20; management, file explorer and built-in viewers (Section 4).

\- Holds \*\*no administrative privileges\*\*. It reads the current rules from

&#x20; the agent over local IPC and asks the agent to perform privileged

&#x20; actions.



\---



\## 4. Staff App Experience



\### 4.1 Design goals



\- \*\*Familiar:\*\* anyone who has used Windows can use Rulebox without

&#x20; training.

\- \*\*Simpler:\*\* only approved apps and the employee's own files; no clutter.

\- \*\*More beautiful than Windows:\*\* consistent custom design, Mica/Acrylic

&#x20; materials on Windows 11, rounded corners, smooth animations and full

&#x20; organization branding (motion rules in Section 25).

\- \*\*Fast:\*\* the desktop and taskbar must stay responsive with several apps

&#x20; open.



\### 4.2 Shell layout



The Staff App runs as several coordinated windows:



| Shell window | Behavior |

|---|---|

| \*\*Desktop\*\* | Fullscreen, always at the bottom; wallpaper and desktop icons |

| \*\*Taskbar\*\* | Always on top at the screen edge; reserves its space so maximized apps never cover it |

| \*\*Start menu\*\* | Popup with app grid, search, recent files, user profile, Log out and power options |

| \*\*Quick settings\*\* | Popup for Wi-Fi, volume, brightness and battery |

| \*\*Login screen\*\* | Fullscreen, shown before sign-in and after logout |



\### 4.3 Taskbar



\- Pinned apps (set by the admin) and running apps, with an indicator for

&#x20; open and active windows.

\- Click to open, focus, minimize or restore an app.

\- Right-click for Close window and other actions.

\- Hover to show a \*\*live window thumbnail preview\*\*.

\- System area: clock, Wi-Fi, volume, battery, notifications and the

&#x20; signed-in employee's avatar.



\### 4.4 Windows



Every app opens in its own top-level window that can be moved, resized,

minimized, maximized and closed.



| App kind | Title bar | Notes |

|---|---|---|

| Built-in windows (file explorer, viewers, players) | Rulebox custom title bar | Full design control |

| Web apps | Rulebox custom title bar | Each web app runs in its own WebView (not an iframe, since many sites block embedding) |

| Desktop apps (Zoom, LibreOffice, VLC) | The app's own title bar | Tracked and controlled by the Rulebox taskbar |



Additional window features:



\- \*\*Rulebox app switcher\*\* (Alt + Tab style) with app icons and previews.

\- \*\*Snap layouts\*\* for Rulebox windows (half screen, quarter screen,

&#x20; maximize), available from the title bar and keyboard shortcuts.

\- Window positions are remembered per employee and per app.



> \*\*Implementation note:\*\* a web app window needs two layers: a local

> Rulebox title bar and the remote web content. Tauri v2 supports multiple

> webviews in one window behind an unstable feature flag. If this proves

> unreliable, web app windows fall back to the native Windows title bar.



\### 4.5 Shell integration



Because Explorer is not running, Rulebox must provide what Explorer

normally does. The Staff App backend (Rust) uses Win32 APIs for:



\- \*\*Window tracking:\*\* register for shell window events (window created,

&#x20; destroyed, activated, title changed) and enumerate existing app windows.

\- \*\*Window control:\*\* minimize, restore, focus and close any window owned

&#x20; by the Staff session.

\- \*\*Work area:\*\* reserve screen space for the taskbar.

\- \*\*Minimized windows:\*\* configure Windows to hide minimized windows so

&#x20; they appear only in the Rulebox taskbar.

\- \*\*Thumbnails:\*\* use the Windows desktop compositor's thumbnail API for

&#x20; live previews.

\- \*\*System tray host:\*\* receive tray icons from desktop apps such as Zoom

&#x20; (v1.x; see Section 13.4 for the v1 approach).

\- \*\*Quick settings:\*\* Wi-Fi, volume, brightness and battery through

&#x20; Windows APIs, with privileged actions handled by the agent.



\### 4.6 File explorer



\- Shows only the signed-in employee's folder, with familiar views (grid,

&#x20; list), breadcrumbs, search, sort, rename, copy, move and delete.

\- Double-click opens a file with the correct built-in viewer or approved

&#x20; app (Section 7).

\- Right-click "Open with" lists only approved apps for that file type.

\- Shows a storage bar with the employee's quota and usage (Section 8).

\- Labeled clearly as \*\*"Files on this laptop"\*\*.



\### 4.7 Power and session



\- Start menu actions: Log out, Sleep, Restart and Shut down (each can be

&#x20; enabled or disabled by the admin).

\- Optional idle timeout that locks or logs out the employee.



\---



\## 5. Employee Sign-In



\### 5.1 Flow



1\. The PC starts, the Staff Windows account signs in automatically and the

&#x20;  Rulebox login screen appears.

2\. The employee signs in with their own credentials.

3\. Rulebox shows the desktop with the apps and files assigned to that

&#x20;  employee.

4\. \*\*Log out\*\* closes the employee's apps, clears their session and

&#x20;  returns to the login screen.



Any employee can sign in on any enrolled laptop their organization or

group allows.



\### 5.2 Requirements



\- \*\*Online sign-in:\*\* credentials are verified against Convex.

\- \*\*Offline sign-in:\*\* after a successful online sign-in, a salted hash of

&#x20; the credentials is cached on the device so the employee can sign in

&#x20; offline for a period set by the admin.

\- \*\*Rate limiting:\*\* repeated failed sign-ins temporarily lock the account

&#x20; and are reported to the dashboard.

\- \*\*Auto logout:\*\* optional idle timeout configured from the dashboard.

\- \*\*Assignment:\*\* apps can be assigned per group and per employee.



\### 5.3 Isolation between employees (v1)



In v1, all employees share one Windows Staff account, so Rulebox isolates

employees itself:



\- Each employee has a separate WebView data folder, so web app logins and

&#x20; cookies are never shared.

\- On logout, the agent closes all apps the employee launched.

\- Each app definition can list \*\*data folders to reset on logout\*\* (for

&#x20; example, a desktop app's saved login), which the agent wipes.

\- The file explorer shows only the signed-in employee's folder.



> \*\*Known limitation:\*\* desktop apps with file dialogs can still browse

> outside the employee's folder. A hidden Windows account per employee

> (Decision 13) would remove this limitation.



\---



\## 6. App Types



Administrators add apps from the dashboard. Every type appears to

employees as a standard icon in the Start menu, desktop or taskbar.



| Type | How it is added | How it runs |

|---|---|---|

| \*\*Winget app\*\* (e.g. Zoom) | Selected from the winget catalog | Agent installs silently; Staff App launches the executable |

| \*\*Web app / PWA\*\* | URL only | Opens in its own Rulebox window, restricted to an allowlist of domains |

| \*\*Custom installer (MSI/EXE)\*\* | Installer upload plus silent-install flags | Agent downloads, verifies the hash, installs silently |

| \*\*Portable EXE\*\* | Executable upload | Agent verifies the hash and copies it to the managed apps folder |



App types are implemented as plugins so the community can add more

(Section 15).



\### 6.1 Automatic metadata for web apps



When an administrator pastes a URL, the server:



1\. Reads the site's web app manifest to get the name, icon and theme

&#x20;  colors.

2\. Falls back to apple-touch-icon, then favicon, then a generated letter

&#x20;  icon.

3\. Stores the icon on our side and shows an editable preview.



Existing web apps require \*\*no changes\*\* to work.



\### 6.2 Domain allowlists for web apps



Each web app has a primary domain plus an editable list of \*\*additional

allowed domains\*\*. This is required because sign-in flows (SSO, OAuth)

redirect to identity providers such as `login.microsoftonline.com` or

`accounts.google.com`. Navigation to any other domain is blocked with a

clear "not allowed" screen.



\### 6.3 Per-app settings



\- Pinned to taskbar or desktop

\- Data folders to reset on logout

\- File types the app handles (Section 7)

\- Groups and employees allowed to use it

- Web app permissions: camera, microphone, clipboard and more (Section 24.1)



\---



\## 7. File Handling



\### 7.1 Built-in viewers



Rulebox opens common files directly in its own windows, without any

external app:



| Format | Support |

|---|---|

| MP3, WAV, AAC, OGG | Built-in music player |

| MP4 (H.264), WebM | Built-in video player |

| PDF | Built-in viewer |

| JPG, PNG, GIF, WebP | Built-in image viewer |

| TXT, CSV | Built-in text viewer |

| DOCX, XLSX, PPTX | Read-only preview |



\### 7.2 External apps



For editing or unsupported formats (for example MKV or HEVC video),

admins install an approved app such as LibreOffice, OnlyOffice or VLC and

map file types to it in the dashboard:



```json

"fileHandlers": {

&#x20; ".docx": "libreoffice",

&#x20; ".xlsx": "libreoffice",

&#x20; ".mkv": "vlc"

}

```



Rulebox uses only this table and never Windows' default file

associations.



\### 7.3 Security rules



\- Executable and script files are never opened: `.exe`, `.msi`, `.bat`,

&#x20; `.cmd`, `.ps1`, `.vbs`, `.js`, `.hta`, `.lnk` and similar.

\- Office macros are disabled by policy.

\- Files downloaded from web apps are saved only to the employee's folder.

\- Every external file-handling app is added to the escape-test checklist

&#x20; (Section 13.1).



\---



\## 8. Local Storage and Quotas



\- Each employee gets a personal folder on each laptop they use.

\- Files stay on that laptop; they do not follow the employee to other

&#x20; laptops in v1.

\- The agent reports total, used and free disk space per device to the

&#x20; dashboard.

\- Admins set a storage quota per employee from the dashboard.

\- \*\*v1 enforcement (soft):\*\* the agent monitors folder sizes, warns the

&#x20; employee near the limit and blocks new saves through Rulebox once the

&#x20; limit is reached. External apps may still exceed the limit.

\- \*\*Future enforcement (hard):\*\* Windows disk quotas, available once

&#x20; employees have their own Windows accounts (Decision 13).



\---



\## 9. Core Flows



\### 9.1 Enrolling a new PC



1\. The administrator signs in to the local Windows admin account.

2\. Runs the Rulebox installer (one MSI for all organizations).

3\. The installer runs the compatibility check (Section 14).

4\. The administrator enters the \*\*enrollment code\*\* from the dashboard.

5\. The agent registers the device, creates the Staff Windows account,

&#x20;  configures automatic sign-in and sets the Staff App as the shell.

6\. The device appears on the dashboard as 🟢 Online.



\### 9.2 Daily use



1\. The PC starts and the Rulebox login screen appears.

2\. The employee signs in (Section 5).

3\. The employee uses approved apps, websites and files.

4\. The employee logs out, and the next employee can sign in.



\### 9.3 Administrator makes a change



1\. In the dashboard, the administrator selects "Install Zoom" for the

&#x20;  Sales group.

2\. Convex stores the updated \*\*desired state\*\* for those devices.

3\. Agents receive the change immediately over the live connection.

4\. Each agent installs Zoom silently and reports ✅ or ❌ with details.

5\. Zoom appears in the Start menu for allowed employees.



\### 9.4 Device is offline



1\. The change is shown on the dashboard as ⏳ Pending.

2\. Employees continue working with the locally cached rules.

3\. When the device reconnects, the agent compares current state with

&#x20;  desired state and resolves the differences.



\### 9.5 Returning to normal Windows



\- \*\*Ctrl + Alt + Del → Switch user → Admin\*\* opens a normal Windows

&#x20; session.

\- From the dashboard: \*\*Disable kiosk\*\* / \*\*Enable kiosk\*\* at any time.

\- Hidden admin exit inside the Staff App (key combination + PIN,

&#x20; Section 12.4).



\---



\## 10. Desired State Model



Rulebox does not send one-off commands. It stores \*\*how each device

should look\*\*, and the agent continuously reconciles the device to match.



```json

{

&#x20; "kioskEnabled": true,

&#x20; "apps": \["orders-web", "zoom", "tally", "libreoffice"],

&#x20; "allowedSites": \["portal.company.com"],

&#x20; "fileHandlers": { ".docx": "libreoffice" },

&#x20; "storage": { "defaultQuotaGb": 10 },

&#x20; "branding": { "name": "Company OS", "logo": "..." },

&#x20; "version": 42

}

```



Benefits:



\- Offline devices converge automatically when they reconnect.

\- No stale commands are replayed.

\- Every change is versioned, which supports auditing and rollback.



\---



\## 11. Smart Heartbeat



Designed to stay within the Convex free tier.



\- The server tells each device when to report next (`nextPingIn`).

\- The interval grows with fleet size (e.g. 2 → 5 → 10 minutes).

\- Random jitter prevents devices from reporting at the same moment.

\- Full status payloads are sent only when something changes.

\- The live Convex connection is the primary "online" signal.



> \*\*Note:\*\* each connected device holds an open connection. Confirm the

> current Convex free-tier limits on concurrent connections and function

> calls before scaling past a pilot fleet.

### 11.1 Data access rules

Rulebox must stay fast as data grows and stay inside the Convex free
tier. Example of the risk: 100 devices sending a heartbeat every 5 minutes
is about 864,000 function calls per month, close to the free tier's
monthly allowance, and each write would re-run every open dashboard's
device list.

| # | Rule | Applies to |
|---|---|---|
| 1 | **One query per screen.** Queries join data on the server and return exactly what the screen shows; no chains of 10+ small client calls | Dashboard, Staff App |
| 2 | **Indexed reads only.** Every query uses an index; no full-table filters | All Convex functions |
| 3 | **Paginate growing data.** Never load a growing table in full; lists paginate, "latest" views take a fixed number of rows | Audit log, devices, employees, install results, history |
| 4 | **Separate fast-changing data.** Online status and last-seen time are stored apart from device records so heartbeats do not refresh device lists | Devices |
| 5 | **Write only on change.** Heartbeats and status reports write only when something changed; the live connection is the primary online signal | Agent |
| 6 | **One subscription per agent.** Each agent subscribes to its own desired state and does not poll | Agent |



\---



\## 12. Security and Lockdown



Replacing the shell is straightforward; \*\*keeping employees inside it is

the core engineering challenge\*\*. Lockdown is a primary feature, not an

optional extra.



\### 12.1 Threat model



| Threat | Example |

|---|---|

| Employees escape the kiosk | Using a file dialog in Zoom to open Explorer or run an executable |

| Employees tamper with the agent | Stopping the service, deleting files, changing registry keys |

| One employee accesses another's data | Opening a desktop app still signed in as the previous employee |

| Compromised backend or admin account | Attacker pushes a malicious installer to every enrolled device |

| Stolen enrollment code | Attacker enrolls a rogue device into the organization |

| Network attacker | Intercepting or modifying installer downloads |



\### 12.2 Device lockdown (Windows)



\- \*\*Standard user account:\*\* the Staff Windows account has no admin rights

&#x20; and cannot install software.

\- \*\*Application allowlisting:\*\* App Control for Business (WDAC) or

&#x20; AppLocker restricts which executables can run for the Staff account.

&#x20; This is the main defense against escapes through file dialogs and child

&#x20; processes.

\- \*\*Policy restrictions\*\* applied to the Staff account:

&#x20; - Disable Task Manager, Run dialog, Command Prompt, PowerShell and

&#x20;   Registry Editor

&#x20; - Remove non-essential options from the Ctrl + Alt + Del screen

&#x20; - Disable Windows key shortcuts (Win + E, Win + R, Win + X, etc.)

&#x20; - Hide drives and restrict file dialogs where possible

&#x20; - Disable USB storage (optional, per policy)

\- \*\*Protected agent:\*\* the service runs as SYSTEM, its files and registry

&#x20; keys have restrictive ACLs, and Windows service recovery restarts it if

&#x20; it crashes.

\- \*\*Escape testing:\*\* every release is tested against the escape

&#x20; checklist (Section 13.1).



\### 12.3 Backend and supply-chain trust



Because the agent can install software on every device, the backend is

effectively a remote-execution system and is protected accordingly.



\- \*\*Admin authentication:\*\* two-factor authentication required for Owner

&#x20; and Admin roles.

\- \*\*Enrollment tokens:\*\* short-lived, single-use or limited-use, revocable

&#x20; from the dashboard.

\- \*\*Hash verification:\*\* every installer and portable executable is

&#x20; verified against its SHA-256 hash before use.

\- \*\*Signed policies (v1):\*\* desired-state documents and installer

&#x20; manifests are signed by an organization key; the agent rejects anything

&#x20; with an invalid signature.

\- \*\*Code signing:\*\* the agent, Staff App and installer are code-signed.

\- \*\*Audit log:\*\* every administrative action is recorded with who, what

&#x20; and when.

\- \*\*Transport:\*\* all traffic over TLS.



\### 12.4 Hidden admin exit



The Staff App provides a secret key combination that prompts for a PIN.



\- The PIN is stored only as a salted hash.

\- Attempts are rate-limited, with lockout after repeated failures.

\- Every use is reported to the dashboard audit log.

\- The PIN can be rotated or disabled remotely.



\---



\## 13. Known Edge Cases and Risks



\### 13.1 Kiosk escape vectors



| Vector | Mitigation |

|---|---|

| File Open/Save dialogs in allowed apps (Zoom, Tally, LibreOffice) | App allowlisting; restricted dialogs; test each allowed app |

| Links in allowed apps opening a browser | Route link handling to Rulebox or block it |

| Help windows and "Open file location" options | App allowlisting; test each allowed app |

| Media players opening network URLs (VLC) | Restrict by policy; test |

| Office macros | Disable by policy |

| Accessibility tools (Sticky Keys, Narrator, On-Screen Keyboard) | Disable for the Staff account or restrict via policy |

| Ctrl + Alt + Del screen | Remove non-essential options via policy |

| Windows key shortcuts | Disable via policy |

| Boot into Safe Mode or recovery | BIOS/UEFI password, BitLocker, disable advanced boot options |

| Apps that self-update or launch helper processes | Allowlist by publisher rather than path where possible |



\### 13.2 Windows edition differences



Some lockdown features differ by Windows edition. The installer

compatibility check (Section 14) detects what is available on each PC.



| Feature | Home | Pro | Enterprise / Education |

|---|---|---|---|

| Custom shell per user (registry) | Verify | Yes | Yes |

| Shell Launcher | No | No | Yes |

| AppLocker | No | Verify | Yes |

| App Control for Business (WDAC) | Verify | Verify | Yes |

| Group Policy restrictions | Registry only | Yes | Yes |



> Items marked "Verify" must be confirmed by testing on current Windows

> builds before release.



\### 13.3 Employee session edge cases



\- \*\*Saved logins in desktop apps:\*\* apps like Zoom keep the previous

&#x20; employee signed in unless their data folders are reset on logout.

\- \*\*Apps still running at logout:\*\* the agent closes them; unsaved work

&#x20; may be lost, so Rulebox warns the employee before logging out.

\- \*\*Files on other laptops:\*\* files are local in v1 and are not available

&#x20; when the employee uses a different laptop.

\- \*\*Offline sign-in for new employees:\*\* an employee who has never signed

&#x20; in online on a laptop cannot sign in on it while it is offline.



\### 13.4 Shell integration edge cases



| Issue | Detail | Mitigation |

|---|---|---|

| \*\*System tray\*\* | Apps like Zoom hide in the tray when closed; without a tray host they become unreachable | v1: configure such apps not to minimize to the tray; v1.x: Rulebox tray host |

| \*\*Notifications\*\* | Windows toast notifications from desktop apps may not appear without Explorer | Test per app; Rulebox shows its own notifications for web apps |

| \*\*Minimized windows\*\* | Without a shell, Windows shows minimized windows as small bars | Configure Windows to hide them; show them only in the Rulebox taskbar |

| \*\*Maximized windows covering the taskbar\*\* | Windows does not know about the Rulebox taskbar by default | Rulebox reserves the work area |

| \*\*Multiple monitors\*\* | Taskbar and work area must be handled per monitor | Primary monitor only in v1; multi-monitor in v1.x |

| \*\*Memory use\*\* | Each Rulebox window is a WebView | Share one WebView2 environment per employee; suspend hidden windows |

| \*\*Snap behavior\*\* | Windows' own snapping may behave differently without Explorer | Rulebox snap layouts for its own windows; test external apps |



\### 13.5 Operational edge cases



\- \*\*Automatic sign-in:\*\* credentials for the Staff Windows account are

&#x20; stored securely (LSA secret), not as plain-text registry values.

\- \*\*Windows Update:\*\* forced reboots can interrupt work; configure active

&#x20; hours and update policies from the dashboard.

\- \*\*App self-updates:\*\* apps like Zoom update themselves; allowlist rules

&#x20; must not break when versions change.

\- \*\*Failed installs:\*\* report the exit code and log to the dashboard;

&#x20; retry with backoff; never show a half-installed app.

\- \*\*UAC prompts:\*\* any action that triggers UAC in the Staff session is a

&#x20; bug; privileged work must go through the agent.

\- \*\*Clock drift:\*\* token and signature checks tolerate small clock

&#x20; differences.

\- \*\*Agent upgrades:\*\* the agent updates itself safely and rolls back if

&#x20; the new version fails to start.

\- \*\*Uninstall/unenroll:\*\* removing Rulebox fully restores the normal

&#x20; Windows shell and removes the Staff account if requested.

### 13.6 Researched risks (October 2026)

Risks found by checking this design against current documentation. Each
has a recommended solution.

> **Note for implementers:** these solutions are recommendations, not
> fixed rules. If you find a better solution during implementation, use it
> and **tell the project owner** what changed and why, so this document can
> be updated.

| # | Risk | Impact | Recommended solution |
|---|---|---|---|
| 1 | **winget CLI does not support the SYSTEM context** (Microsoft documents this; it is an MSIX app registered per user) | The agent runs as SYSTEM, so "agent installs winget apps silently" fails as written | Use the `Microsoft.WinGet.Client` PowerShell module (PowerShell 7, `-MTA`), or resolve the installer URL and SHA-256 from the winget manifest on the server and install it like a custom MSI. Prefer machine-wide installers (e.g. the Zoom MSI, not the per-user EXE) |
| 2 | **App Control for Business policies are device-wide**; per-user rules are not available. AppLocker is not dependable on Home/Pro | Allowlisting also restricts the admin account; Home edition may have no per-user allowlisting | One App Control policy that allows Windows, Program Files and signed publishers (admin stays usable), plus an agent **process watchdog** that terminates non-allowlisted processes in the Staff session. The watchdog is the main defense on Home |
| 3 | **Shell Launcher is only on Enterprise, Education and IoT Enterprise** | On Pro/Home the per-user registry shell is used, which does not restart the shell on crash; with Task Manager disabled the employee is stuck on a black screen | Agent watchdog (Section 23.7) relaunches the Staff App within ~2 seconds. If it keeps crashing and no previous version exists to roll back to, show a minimal native "Contact your admin" screen instead of a black screen |
| 4 | **Windows support deadlines:** Windows 10 consumer ESU ends 13 October 2026 (one report claims a one-year extension; unconfirmed). Windows 11 24H2 Home/Pro also reaches end of servicing on 13 October 2026 | Many 4 GB target laptops run Windows 10 or cannot upgrade; a locked PC without security updates is still insecure | Define a minimum supported build. The compatibility check (Section 14) flags "OS out of support", and the dashboard shows a red badge on those devices |
| 5 | **Convex free-tier limits:** 16 concurrent queries and 16 concurrent mutations; sustained overuse may return HTTP errors | After a power or network outage every device reconnects at once; if sign-in depends on Convex, nobody can log in | Random jitter on reconnect (not only on heartbeats). Sign-in always falls back to the cached credentials when Convex is slow or erroring. Use Convex Rust client 0.10.3 or later (fixes reconnect state; `set_auth_callback` refreshes tokens on reconnect) |
| 6 | **Offline sign-in lets removed employees in** | A cached credential hash keeps working until the offline period expires | Include a revoked-employees list in the desired state, keep the default offline period short (e.g. 3 days) and hash cached credentials with Argon2id |
| 7 | **Tauri multiwebview is still behind an unstable flag** | The custom title bar for web app windows may break on Tauri upgrades | Build the native title bar fallback (Section 4.4) **first**; add the custom title bar as an enhancement |
| 8 | **Ctrl + Alt + Del → Switch user shows the admin account** | Employees can attempt to guess the admin password | Enable an account lockout policy and hide the admin tile from the sign-in screen; the admin signs in through "Other user" |
| 9 | **Audit log and policy signing were planned for v1.x**, but v1 already pushes installers to every device and Section 12.4 reports admin-exit use to the audit log | v1 would be a remote-execution system without full accountability or tamper protection | **Resolved:** both moved into v1 (Decision 15, Roadmap v1 item 6) |



\---



\## 14. Installer Compatibility Check



Before installation, the Rulebox installer checks the PC and reports

results clearly.



| Check | Result if failed |

|---|---|

| Windows version and build | Block install |

| Windows edition and available lockdown features | Install with reduced lockdown, or block, depending on organization policy |

| WebView2 runtime | Install it automatically |

| Administrator rights | Block install |

| Free disk space | Block install |

| Existing kiosk or MDM software | Warn |



The result is sent to the dashboard during enrollment, so administrators

can see which lockdown level each device supports.



\---



\## 15. Open Source and Generic Design



\- \*\*Bring your own Convex:\*\* clone the repository, run `npx convex deploy`,

&#x20; done.

\- \*\*One generic installer:\*\* the enrollment code contains the Convex URL

&#x20; and an enrollment token.

\- \*\*Everything is configuration:\*\* branding, policies, apps, file handlers

&#x20; and storage quotas are managed from the dashboard.

\- \*\*Multi-organization with roles:\*\* Owner, Admin, Viewer.

\- \*\*Pluggable app types:\*\* Winget, Web, MSI, Portable, Script; the

&#x20; community can add more.

\- \*\*Quick start:\*\* `npx create-rulebox` scaffolds a full deployment.



\---



\## 16. Tech Stack



All components use free tiers or free-for-open-source services.



| Component | Technology |

|---|---|

| Dashboard | Vite + React + TypeScript, custom UI |

| Backend and database | Convex (cloud free tier) |

| Authentication | Convex Auth (with 2FA for admins) |

| Staff App | Tauri v2 + Vite + React, custom UI |

| Shell integration | Rust with the `windows` crate (Win32 window, shell and compositor APIs) |

| Window materials | Mica/Acrylic effects on Windows 11 via Tauri window effects |

| Agent | Rust (`windows-service` crate + Convex Rust client) |

| Installer storage | Cloudflare R2 (Convex file storage is too limited) |

| App updates | Tauri updater + GitHub Releases |

| Dashboard hosting | Cloudflare Pages or Vercel |

| Code signing | SignPath (free for open source) or Azure Trusted Signing |



\---



\## 17. Roadmap



\### v1 — Windows MVP



Goal: \*\*one PC fully locked down, remotely managed and pleasant to use.\*\*



1\. \*\*Staff App shell:\*\* login screen, desktop, taskbar, Start menu, window

&#x20;  management, file explorer, built-in viewers, web app windows.

2\. \*\*Agent:\*\* Windows service, Staff account setup, shell replacement,

&#x20;  lockdown policies, desired-state reconciliation, session cleanup,

&#x20;  storage monitoring.

3\. \*\*Dashboard + Convex:\*\* devices, employees, apps, groups, file

&#x20;  handlers, storage quotas, branding, kiosk toggle.

4\. \*\*Installer:\*\* one MSI with compatibility check and enrollment code.

5\. \*\*Additional v1 features:\*\* web app permissions, Wi-Fi and printer
   profiles, rollout rings with rollback, lost-device lock and broadcast
   messages (Section 24).

6\. \*\*Trust basics:\*\* audit log, and signed desired-state documents and
   installer manifests (Section 12.3, Decision 15).

7\. \*\*Escape testing:\*\* complete the checklist in Section 13.1.

8\. \*\*Pilot:\*\* validate on one PC, then a small group.



\### v1.x — Hardening and polish



\- Agent self-update with rollback

\- Windows Update policy controls

\- System tray host

\- Multi-monitor support



\### v2 — Scale and platforms



\- Multi-organization and roles

\- Plugin system for app types

\- `npx create-rulebox`

\- Hidden Windows account per employee (if Decision 13 changes)

\- Remote screen view and usage tracking (with privacy controls)

- Shift hours per group (Section 24.5)

\- \*\*Android support\*\* (Section 18)

\- Paid hosted version



\---



\## 18. v2: Android Support



\### 18.1 Approach: Device Owner



Android provides a built-in management mode called \*\*Device Owner\*\*. An

app set as Device Owner has near-complete control of the device and plays

the same role as the Windows agent.



Capabilities used:



\- \*\*Lock task mode:\*\* pins the device to the Rulebox launcher

\- \*\*Persistent home screen:\*\* sets the Rulebox launcher as the default

&#x20; home app

\- \*\*Silent app management:\*\* install, update and remove APKs without

&#x20; prompts

\- \*\*User restrictions:\*\* block app installs, factory reset, safe boot, USB

&#x20; debugging and settings changes

\- \*\*System controls:\*\* system update policy, Wi-Fi, camera and more



\### 18.2 Components



| Component | Implementation |

|---|---|

| Agent | Kotlin Device Owner app; connects to Convex and reconciles desired state |

| Rulebox launcher | Tauri v2 (Android) reusing the Rulebox design system in a mobile layout, with native Kotlin for launcher and lock-task features; fallback: Kotlin app hosting the React UI in a WebView |

| Web apps | WebView inside the launcher with the same domain allowlists |

| Backend | Same Convex deployment and dashboard; devices gain a `platform` field |



\### 18.3 Enrollment



1\. Factory reset the device (Device Owner requires an unprovisioned

&#x20;  device).

2\. Tap the welcome screen six times to open the QR provisioning scanner.

3\. Scan a QR code generated by the dashboard containing:

&#x20;  - Agent APK download URL and checksum

&#x20;  - Enrollment data (Convex URL and enrollment token)

4\. The device installs the agent, grants it Device Owner and enrolls

&#x20;  itself.

5\. The device appears on the dashboard as 🟢 Online.



For development, a test device with no accounts can be provisioned with

`adb shell dpm set-device-owner`.



\### 18.4 Returning to normal use



\- \*\*Disable kiosk\*\* from the dashboard exits lock task mode and removes the

&#x20; forced launcher; the device behaves as a normal Android phone.

\- \*\*Enable kiosk\*\* restores the locked mode.

\- The agent remains Device Owner throughout, so the device stays managed.

\- Hidden admin exit in the launcher (gesture + PIN), with the same rules

&#x20; as Section 12.4.



\### 18.5 Android edge cases and risks



| Risk | Detail | Mitigation |

|---|---|---|

| \*\*No silent Play Store installs\*\* | Only approved EMM providers can use managed Google Play | Host APKs on R2; consider Android Management API for Play Store apps |

| \*\*Background connection limits\*\* | Android aggressively stops background network connections | Foreground service with a persistent notification, or Firebase push to trigger sync |

| \*\*Factory reset required\*\* | Existing devices cannot become Device Owner without a reset | Document clearly; offer work profile mode for existing devices |

| \*\*Manufacturer differences\*\* | Some vendors add aggressive battery management or custom behavior | Test on target models; exempt the agent from battery optimization |

| \*\*APK licensing\*\* | Redistributing third-party APKs may violate their terms | Limit to own apps, open-source apps, or apps with permission |



\### 18.6 Alternative: Android Management API



Google's free Android Management API handles enrollment, policies and

Play Store installs. It is faster to start with but depends on Google and

offers less control over the kiosk experience. Possible as a second

backend option if customers need Play Store apps.



\### 18.7 Future option: Work profile (BYOD)



For staff-owned phones, \*\*Profile Owner\*\* mode creates a separate work

profile with managed apps and rules while leaving the personal side

untouched. It does not lock the device.



\### 18.8 Android build order



1\. Kotlin Device Owner agent with lock task mode and launcher, tested via

&#x20;  adb

2\. Convex connection and desired-state reconciliation

3\. Silent APK installs from R2

4\. QR enrollment from the dashboard

5\. Kiosk enable/disable and admin exit



\---



\## 19. Out of Scope



\- \*\*Linux:\*\* not planned.

\- \*\*iOS:\*\* requires Apple MDM, supervised devices and Apple Business

&#x20; Manager. It will be considered only if there is clear customer demand.

&#x20; Reference: NanoMDM.



\---



\## 20. References and Inspiration



Study these projects; do not fork them.



| Project | What to learn |

|---|---|

| Tactical RMM | Agent and dashboard design |

| MeshCentral | Agent-to-server connection patterns |

| Fleet / OpenUEM | Device inventory |

| Cairo Shell / ManagedShell | Replacing the Windows shell: taskbar, tray and window tracking |

| Headwind MDM | Android Device Owner and kiosk implementation |

| NanoMDM | iOS MDM (future reference) |



\*\*What makes Rulebox different:\*\* a beautiful, Windows-like, fully

controlled workspace with per-employee sign-in, simple device management

and a clean custom UI, all in one open-source package.



\---



\## 21. Decisions



\### 21.1 Locked decisions



| # | Decision | Outcome |

|---|---|---|

| 1 | Project name | \*\*Rulebox\*\* (product name: "Rulebox for Windows") |

| 2 | Supported Windows editions | Any edition that passes the installer compatibility check (Section 14) |

| 3 | Linux support | Not planned |

| 4 | File storage | Local for v1, with per-employee quotas set from the dashboard (Section 8) |

| 5 | Staff sign-in | Employees sign in inside the Staff App with their own credentials and can use any enrolled laptop (Section 5) |

| 6 | Hidden admin exit | Yes, with PIN rules from Section 12.4 |

| 7 | Remote screen view / screenshots | Not in v1; planned for a future version |

| 8 | Usage tracking | Not in v1; planned for a future version |

| 9 | License | MIT |

| 10 | Business model | Free open source, with a paid hosted version planned later |

| 11 | Convex hosting | Cloud free tier |

| 12 | Android approach (v2) | Own Device Owner agent first |

| 13 | Employee isolation: shared Windows account with cleanup (A), or hidden Windows account per employee (B) | A for v1; B as a v2 goal |

| 14 | Staff App style | Windows-like desktop with taskbar, Start menu and real windows, using the custom Rulebox design (Section 4) |
| 15 | Audit log and signed policies | Both in **v1** (moved from v1.x), because the backend can push installers to every device (Section 12.3) |
| 16 | Icon set | **Solar Icons** by 480 Design (CC BY 4.0), soft and rounded. Dashboard: *Linear*, with *Bold Duotone* for active states. Staff App: *Bold Duotone*, with *Bold* for selected states. Bundled at build time from Iconify data (`@iconify-json/solar` + `unplugin-icons`) so only used icons ship and nothing loads online. Attribution "Icons: Solar by 480 Design (CC BY 4.0)" appears in `THIRD_PARTY_NOTICES.md` and the Staff App and dashboard About screens. App icons still come from app manifests (Section 6.1) |
| 17 | Offline-first assets | The Staff App works with **no internet**: fonts, icons, GSAP and all UI assets are bundled. No CDNs, Google Fonts, icon fonts or online icon APIs at runtime |
| 18 | Logo and brand animations | Logo: rounded box with three rounded tiles. Its **splash, loading and open-desktop animations are kept as designed** (Section 25.5); logo **colors will change** to the Rulebox palette |



---

## 22. Performance

### 22.1 Goal

Rulebox must run comfortably on low-end laptops with **4 GB of RAM**. The
desktop, a couple of web apps, files, music and video should feel smooth
on this hardware.

> **Expectation:** Windows itself uses a large share of 4 GB, and apps like
> Zoom need several hundred MB during a call. Rulebox minimizes its own
> footprint and Windows' background load, but cannot make many heavy apps
> run at once on 4 GB.

### 22.2 Per-user tuning (Staff account only)

Applied to the Staff Windows account during enrollment. The admin account
is not affected.

| Setting | Effect |
|---|---|
| Explorer not running | Rulebox is the shell, so Explorer's memory is saved |
| No startup apps | OneDrive, Teams, Edge startup boost and others do not launch |
| Background apps disabled | Store apps cannot run in the background |
| Widgets, Copilot, tips and suggestions off | Fewer background processes and network calls |
| Visual effects minimized | Less GPU and memory use from Windows animations |

### 22.3 Kiosk performance profile (machine-wide)

Windows services are machine-wide and cannot be stopped for one user only.
The agent therefore applies a **kiosk performance profile** when kiosk
mode is enabled and **restores the original settings** when kiosk mode is
disabled, so the PC behaves normally for the admin.

| Component | Kiosk profile | Reason |
|---|---|---|
| Windows Search indexing | Disabled | Rulebox provides its own file search |
| SysMain (Superfetch) | Disabled | Preloading apps hurts more than it helps on 4 GB |
| Xbox and Game Bar services | Disabled | Not needed |
| Telemetry and diagnostics | Minimum level | Less background work |
| Print Spooler | Disabled if the admin marks the PC as "no printing" | Not needed |
| Delivery Optimization peer sharing | Disabled | Stops uploading updates to other PCs |
| Windows Defender | **Kept on**; full scans scheduled outside active hours | Security must not be reduced |
| Windows Update | **Kept on**; installs and restarts scheduled outside active hours | Security must not be reduced |

Before applying the profile, the agent records the original state of every
setting it changes, so the restore is exact.

### 22.4 Rulebox footprint

- **Agent:** written in Rust, with a memory footprint of a few MB.
- **WebView budget:** each WebView2 window costs significant memory, so
  Rulebox uses as few as possible:
  - Web apps get their own WebView (required for isolation and because
    many sites block iframes).
  - In Lite mode, built-in windows (file explorer, players, viewers) run as
    in-app windows inside one shared WebView instead of separate ones.
- **One WebView2 environment** per signed-in employee, so all web app
  windows share the same browser process.
- **Suspension:** minimized web apps are suspended and asked to reduce
  memory use; they resume instantly when restored.
- **Idle close:** web apps idle for longer than an admin-set time are
  closed automatically, with a quick reopen from the dock.
- **Lazy loading:** viewers, players and heavy UI parts load only when
  first used.

### 22.5 Display modes

| Mode | When used | Differences |
|---|---|---|
| **Standard** | PCs with more than 4 GB of RAM | Full design: blur and glass materials, animations, high-resolution wallpaper, built-in windows as separate WebViews |
| **Lite** | PCs with 4 GB of RAM or less (chosen automatically) | No blur or glass effects, reduced animations, compressed wallpaper, built-in windows sharing one WebView |

The agent reports RAM, CPU and disk type to the dashboard, and the admin
can override the mode per device or per group.

### 22.6 Monitoring

- The agent reports memory and CPU usage with the regular heartbeat.
- The dashboard flags devices that are frequently low on memory, so admins
  can reduce assigned apps or upgrade hardware.

### 22.7 Hardware recommendations

For best results on low-end laptops:

- An SSD instead of a hard drive (the single biggest improvement)
- Windows 10 or a minimal Windows 11 installation
- Fewer heavy desktop apps assigned to the same PC


---

## 23. Updates

### 23.1 Principles

- Updates must never leave an employee on a broken or black screen.
- Employees choose when to restart Rulebox, within limits set by the admin.
- Every update is verified before it is installed.
- A failed update rolls back automatically.

### 23.2 Who updates what

| Component | Updated by | Reason |
|---|---|---|
| Staff App | Agent | The Staff account is a standard user and cannot install software; the shell must not replace itself while running |
| Agent | Agent (self-update) | Runs as SYSTEM; uses a separate updater process to replace itself |
| Managed apps (winget, MSI, EXE) | Agent | Part of desired-state reconciliation (Section 10) |

The Staff App does **not** use the Tauri updater plugin to install itself.
It reuses the Tauri updater **format** (`latest.json` plus update
signatures) so the release process stays standard.

### 23.3 Staff App installation layout

```
C:\Program Files\Rulebox\
├── rulebox-shell.exe      # Small stable launcher, registered as the shell
├── current.json           # Points to the active version
└── versions\
    ├── 1.4.0\             # Previous version, kept for rollback
    └── 1.5.0\             # New version
```

The launcher never changes. It starts the version named in `current.json`,
so switching versions is a single, atomic change.

### 23.4 Staff App update flow

1. **Check:** the agent learns of a new version through the desired state
   or the release manifest for the device's update channel.
2. **Download:** the agent downloads the new version in the background.
3. **Verify:** the agent checks the file hash and the Tauri update
   signature. Anything that fails verification is discarded and reported.
4. **Prepare:** the new version is unpacked into its own `versions\` folder.
5. **Notify:** the Staff App shows **"Update ready — restart Rulebox"**.
   Restarting takes a few seconds and restarts only Rulebox, not the PC.
6. **Apply** at the first of these moments:
   - The employee selects **Restart Rulebox**
   - The employee logs out
   - The PC restarts
   - A nightly window when no employee is signed in
   - The admin's deadline is reached (Section 23.6)
7. **Switch:** the agent updates `current.json` and restarts the Staff App.
8. **Health check:** the new version must report healthy to the agent
   within a set time (for example 30 seconds).
9. **Rollback:** if the health check fails, the agent switches back to the
   previous version, restarts it, and reports the failure to the
   dashboard. The failed version is not retried until a new release is
   published.

If the employee never selects restart, the next start of Rulebox always
uses the new version.

### 23.5 What employees experience during a restart

- Desktop apps such as Zoom keep running; they are separate processes.
- Web app windows inside Rulebox close and reopen after the restart, with
  their sessions preserved.
- Unsaved work in built-in windows triggers a warning before restarting.

### 23.6 Admin controls

| Control | Description |
|---|---|
| Update channel per group | Dev, beta or stable |
| Pause updates | Hold a group on its current version |
| Deadline | "Install by" time for urgent updates; after it, Rulebox restarts with a short warning to the employee |
| Nightly window | Hours when updates may apply automatically |
| Version status | Dashboard shows the version on each device and any failed or rolled-back updates |

### 23.7 Watchdog

Independent of updates, the agent monitors the Staff App. If it crashes or
exits unexpectedly, the agent relaunches it in the Staff session. Repeated
crashes of a new version trigger the same rollback as a failed health
check.

### 23.8 Signing

There are two independent kinds of signing:

| Signing | Required | Purpose |
|---|---|---|
| Tauri update signature | **Always**, including development | Proves an update comes from us; created free with `tauri signer generate` |
| Windows code signing (Authenticode) | Not required to run | Removes SmartScreen and Defender friction; required before releasing to the stable channel |

- **Development builds are unsigned** for Windows but always carry the
  Tauri update signature. They are published only to the dev channel and
  reach test PCs only.
- Unsigned builds run because the agent installs them (no SmartScreen
  prompt) and the allowlisting path rule permits
  `C:\Program Files\Rulebox` (Section 12.2).
- **Stable releases** are code-signed (for example through SignPath).
- The update signing private key is kept out of the repository and stored
  only in the build pipeline's secrets.

### 23.9 Agent self-update

1. The agent downloads and verifies the new agent version.
2. It starts a small updater process and stops itself.
3. The updater replaces the agent files and starts the service.
4. If the new agent does not report healthy, the updater restores the
   previous version and starts it.

---

## 24. Additional v1 Features

Sections 24.1–24.4 are part of v1. Section 24.5 is planned for a future
version. All of them are expressed through the desired state (Section 10).

### 24.1 Web app permissions

Each web app has its own permission settings, so for example a video-call
web app can use the microphone while other web apps cannot.

| Permission | Default |
|---|---|
| Camera | Blocked |
| Microphone | Blocked |
| Screen sharing | Blocked |
| Clipboard read | Blocked |
| Notifications | Allowed |
| Downloads | Allowed (saved only to the employee's folder, Section 7.3) |
| Printing | Allowed if the device has printers configured |
| Geolocation | Blocked |

- WebView2 raises a permission request for each of these; the Staff App
  answers it from the app's rules and never shows a browser prompt to the
  employee.
- Blocked requests show a short notice ("Microphone is not allowed for
  this app") and are counted on the dashboard so admins can spot missing
  permissions.

### 24.2 Wi-Fi and printer profiles

Employees cannot open Windows settings, so network and printer setup is
pushed from the dashboard.

- **Wi-Fi profiles:** admins add networks (SSID, security type, password
  or certificate) per group. The agent installs them machine-wide so they
  work at the Rulebox login screen, before any employee signs in.
- Passwords are stored encrypted on the server and sent only to devices
  that need them.
- **Printers:** admins add network printers (IP or share path, driver from
  an approved list) per group; the agent installs them. Print Spooler stays
  enabled on these devices (Section 22.3).
- Quick settings (Section 4.2) lists only the networks allowed by policy,
  if the admin enables "Managed networks only".

### 24.3 Rollout rings and rollback

Changes are rolled out in stages so one bad change cannot break every PC
at once.

| Ring | Typical use |
|---|---|
| **Pilot** | One or two test devices chosen by the admin |
| **Early** | A small group of real devices |
| **Everyone** | All remaining devices |

- Every desired-state change (apps, allowlists, policies) can be sent to
  a ring first and promoted with one click.
- Optional automatic promotion: if the ring reports no failures for a set
  time, the change moves to the next ring.
- **Rollback:** because every desired state is versioned (Section 10), the
  admin can return a group to any previous version with one click.
- Staff App and agent releases keep using the update channels from
  Section 23.6.

### 24.4 Lost-device lock and broadcast messages

- **Lock device:** the admin locks a device from the dashboard. The Staff
  App signs out the employee and shows a full-screen message, for example
  "This laptop belongs to Company X. Please call +1 555 …". Only the admin
  exit (Section 12.4) or an unlock from the dashboard ends it.
- The lock is part of the desired state, so it is applied on the next
  connection and stays applied offline and across restarts.
- **Broadcast message:** the admin sends a banner or full-screen notice to
  a group or a single device (for example "Maintenance at 5 pm, please
  save your work"), with an optional expiry time and "acknowledge" button.
- Locks, unlocks and broadcasts are recorded in the audit log.

### 24.5 Shift hours per group (future)

- Admins set allowed sign-in hours per group (for example Sales,
  Monday–Saturday 9:00–18:00).
- Sign-in outside the allowed hours is refused with a clear message.
- At the end of a shift, employees get a 5-minute warning and are then
  logged out automatically (Section 13.3 unsaved-work warning applies).
- Uses the device clock with the clock-drift tolerance from Section 13.5.

---

## 25. Motion and Animation

Applies to the Staff App and the dashboard.

### 25.1 Principles

- Motion is **purposeful and consistent**: it guides attention and shows
  state changes (window open/minimize, menu open, file selected). It is
  never decoration.
- It must stay smooth on 4 GB laptops (Section 22) with minimal CPU, GPU
  and memory use.

### 25.2 Library

- **GSAP** with the **Flip** plugin, chosen for performance, precise
  timeline control and small size (core ~25 KB gzipped). Import only the
  plugins that are used.
- **License note:** GSAP is free for commercial use, including all
  plugins, under its own "Standard No Charge" license. It is **not** an
  open-source license like Rulebox's MIT. This is acceptable because
  Rulebox is not a visual animation builder (the license's only
  prohibited use). Mention it in the project's third-party notices.
- Simple hover and press effects (e.g. tile lift, button press) use plain
  CSS transitions. GSAP is for sequences, window animations and
  layout changes.

### 25.3 Rules

- **Compositor-only properties:** animate only `transform` and `opacity`
  (GSAP `x`, `y`, `scale`, `autoAlpha`). Never animate `width`, `height`,
  `top`, `left` or other layout properties.
- **Layout changes** (expand, collapse, reorder, maximize/restore of
  Rulebox windows) use the FLIP technique through GSAP Flip.
- **View Transitions API** may be used for screen and state transitions
  (e.g. sign-in → desktop). WebView2 is Chromium-based and supports it;
  keep a simple fallback in case it is unavailable.
- **Cleanup:** every animation is created inside `useGSAP()` or
  `gsap.context()` and is reverted on unmount to prevent memory leaks.
- **Hidden windows:** animations stop when a window is minimized or
  suspended (Section 22.4).
- **Reduced motion:** respect `prefers-reduced-motion`: replace movement
  with short fades or none.
- **Lite mode** (Section 22.5): only short opacity fades (≤150 ms); no
  movement, scaling, blur or Flip animations.
- **Durations:** most UI motion is 150–300 ms with the shared easing token
  from the design system; nothing blocks input while animating.
- **Scope:** only Rulebox's own windows are animated. Desktop apps (Zoom,
  LibreOffice) use their normal Windows behavior.

### 25.4 Testing

- Windows (WebView2) is the only v1 target. The **performance baseline**
  is a 4 GB RAM laptop in Lite mode. Animations must not drop frames
  noticeably there or raise idle CPU usage.
- v2: also test in the Android System WebView used by the Rulebox launcher
  (Section 18).

### 25.5 Logo and brand animations (Decision 18)

Reference: `design/logo/rulebox_logo_gsap_animation.html`. The animations
are kept as designed; only colors change.

**Logo geometry** (`viewBox="0 0 120 120"`):

| Part | Shape | Current color → planned |
|---|---|---|
| `box` | `rect x=10 y=10 w=100 h=100 rx=28`, stroke 8, no fill | Ink → Rulebox ink token |
| `tA` | `rect x=26 y=26 w=30 h=68 rx=10` (tall tile) | Ink → Rulebox ink token |
| `tC` | `rect x=64 y=64 w=30 h=30 rx=10` | Secondary text → muted token |
| `tB` | `rect x=64 y=26 w=30 h=30 rx=10` | Purple `#7F77DD` → Rulebox **teal accent** |

Wordmark: "rulebox", lowercase, weight 500, each letter animatable.

| Animation | Where used | Sequence |
|---|---|---|
| **Splash** | App start, before the login screen | Box outline draws in (0.9 s) while rotating from −90° and scaling up; tall and small tiles pop in (`back.out`); accent tile drops in with a bounce; wordmark letters rise in with a stagger |
| **Loading** | Waiting states (agent starting, first sync, sign-in check) | Looping: the three tiles shrink and grow in a staggered wave; the accent tile rotates 90°; wordmark dimmed |
| **Open desktop** | After successful sign-in | Letters lift out, box scales up and fades, small tiles shrink away, accent tile zooms ×5 and fades, then desktop tiles pop in with a stagger |

Implementation rules:

- GSAP is bundled, not loaded from a CDN (Decision 17).
- The splash's outline draw animates `strokeDashoffset` on one small SVG.
  This is the only allowed exception to the transform/opacity rule.
- Lite mode and reduced motion: show the static logo with a short fade;
  "Loading" becomes a gentle opacity pulse; "Open desktop" becomes a
  cross-fade.
- The splash never delays sign-in: it is skipped or cut short as soon as
  the login screen is ready.
