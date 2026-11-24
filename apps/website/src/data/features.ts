/*
 * Feature copy. Source: docs/website/story-and-copy.md §8.2 (blocks F1-F13),
 * §12.2 (titles and descriptions) and the truth table §8.1.
 * Edit the copy file first, then this file. Do not add claims here.
 */
import type { IconName } from "../components/Icon.astro";

export type Tone = "blue" | "sun" | "coral" | "violet" | "mint";

export interface Feature {
  slug: string;
  name: string;
  icon: IconName;
  tone: Tone;
  /** H1 on the feature page. */
  headline: string;
  oneLine: string;
  title: string;
  description: string;
  points: string[];
  doesNotDo: string[];
  /** Site label from the truth table, when the claim is not plain v1. */
  status?: "New" | "Planned";
  useCases: string[];
  prd: string;
}

export const FEATURES: Feature[] = [
  {
    slug: "lockdown",
    name: "Lockdown",
    icon: "lock",
    tone: "coral",
    headline: "Locked means locked.",
    oneLine: "Staff get a desktop with no way out to Windows settings, installers or a free browser.",
    title: "Windows PC Lockdown for Staff | Rulebox",
    description:
      "No admin rights, approved programs only, no Task Manager or Run box. How Rulebox keeps staff inside the desktop you built.",
    points: [
      "Staff run as a standard user with no admin rights. Only approved programs can start.",
      "Task Manager, Run, Command Prompt, PowerShell, Registry Editor and the Windows key shortcuts are off for staff. The Ctrl+Alt+Del screen is emptied.",
      "A service that staff cannot stop watches the desktop and brings it back if it crashes.",
    ],
    doesNotDo: [
      "Protection depends on the Windows edition. The installer tells you “Full” or “Reduced” for each PC, and the dashboard shows it.",
      "Physical attacks, such as booting from USB, need a BIOS password and BitLocker, which you set up.",
    ],
    useCases: ["retail-pos", "clinics-and-pharmacies"],
    prd: "PRD 12.2, 13.1",
  },
  {
    slug: "staff-desktop",
    name: "Staff desktop",
    icon: "monitor",
    tone: "blue",
    headline: "Feels like Windows. Only simpler.",
    oneLine: "A taskbar, a Start menu and real windows, showing only the apps you approved.",
    title: "A Friendly Locked Desktop for Staff | Rulebox",
    description:
      "A taskbar, a Start menu and real windows, showing only approved apps. Familiar to anyone who has used Windows.",
    points: [
      "Apps open in real windows that move, resize, snap and minimise.",
      "Hover a taskbar button for a live preview. Alt+Tab works.",
      "Quick settings for Wi-Fi, volume, brightness and battery.",
    ],
    doesNotDo: [
      "Primary monitor only in v1.",
      "Apps that hide in the system tray need a setting change in v1.",
    ],
    useCases: ["shared-staff-pcs", "hotels-front-desk"],
    prd: "PRD 4, 13.4",
  },
  {
    slug: "employee-sign-in",
    name: "Employee sign-in",
    icon: "user-id",
    tone: "violet",
    headline: "Any person. Any Rulebox PC.",
    oneLine: "Each staff member signs in with their own details and gets their own apps, files and web logins.",
    title: "Per-Person Sign-In on Shared PCs | Rulebox",
    description:
      "Each staff member signs in on any Rulebox PC and gets their own apps, files and web logins. Works offline too.",
    points: [
      "Works offline after the first online sign-in, for as long as you allow.",
      "Repeated wrong passwords lock the account for a while and show up in the dashboard.",
      "Log-out closes the person’s apps and clears the session.",
    ],
    doesNotDo: [
      "Files stay on the laptop where they were saved.",
      "Desktop apps with their own file dialogs can still browse outside the person’s folder in v1.",
    ],
    useCases: ["shared-staff-pcs", "call-centres"],
    prd: "PRD 5",
  },
  {
    slug: "apps",
    name: "Apps and web apps",
    icon: "widget",
    tone: "sun",
    headline: "Your apps, installed for you.",
    oneLine: "Pick an app in the dashboard. Rulebox installs it on every PC in the group, silently.",
    title: "Install Apps on Every PC from the Web | Rulebox",
    description:
      "Pick an app in the dashboard and Rulebox installs it silently on every PC in the group, hash-checked first.",
    points: [
      "Four kinds: apps from the winget catalogue, web apps from a URL, MSI/EXE installers and portable programs.",
      "Paste a URL and Rulebox fetches the name and icon. The web app opens in its own window, limited to the domains you list.",
      "Every installer is checked against its SHA-256 hash before it runs.",
    ],
    doesNotDo: [
      "An installer that insists on a click cannot be silent. Rulebox reports “needs interaction” so you can fix the switches.",
    ],
    useCases: ["retail-pos", "schools-and-computer-labs"],
    prd: "PRD 6, 12.3",
  },
  {
    slug: "dashboard",
    name: "Dashboard",
    icon: "laptop",
    tone: "mint",
    headline: "Every PC, one web page.",
    oneLine: "See which PCs are online, what is installed, and change the rules for a group in seconds.",
    title: "Manage Every Kiosk PC from One Dashboard | Rulebox",
    description:
      "Groups for PCs and people, status per PC, an audit log of every admin action. Change the rules from any browser.",
    points: [
      "Groups for PCs and for people. Assign apps to either.",
      "Status per PC: online, disk space, memory pressure, Windows support state, protection level.",
      "An audit log of every administrative action.",
    ],
    doesNotDo: ["No remote screen view or usage tracking in v1."],
    useCases: ["shared-staff-pcs", "retail-pos"],
    prd: "PRD 3.1, 12.3",
  },
  {
    slug: "updates-and-rollouts",
    name: "Updates and rollouts",
    icon: "branch",
    tone: "blue",
    headline: "Change one PC first. Then all of them.",
    oneLine: "Staged rollouts and one-click rollback for every change.",
    title: "Staged Rollouts and One-Click Rollback | Rulebox",
    description:
      "Send a change to one test PC, then a few, then all. Roll back to any earlier version with one click.",
    points: [
      "Three rings: Pilot, Early, Everyone. Promote by hand or automatically when no failures are reported.",
      "Per-app update choice: pinned version, the vendor’s own updater, or Rulebox-managed versions.",
      "Rulebox verifies its own updates before installing and rolls back if the new version fails its health check.",
    ],
    doesNotDo: ["In v1, Rulebox updates itself only when nobody is signed in."],
    status: "New",
    useCases: ["call-centres", "retail-pos"],
    prd: "PRD 23, 24.3",
  },
  {
    slug: "offline",
    name: "Works offline",
    icon: "offline",
    tone: "violet",
    headline: "The internet can drop. Work does not.",
    oneLine: "Rules live on the PC. Changes wait and apply when it reconnects.",
    title: "Kiosk PCs That Keep Working Offline | Rulebox",
    description:
      "Rules, apps and sign-in live on the PC. Changes wait and apply when the connection returns.",
    points: [
      "Staff keep their apps, files and sign-in while offline.",
      "The dashboard shows waiting changes as “Pending”.",
      "No stale commands: the PC moves to the latest desired state, not through a backlog.",
    ],
    doesNotDo: ["A person who has never signed in on a PC cannot do their first sign-in while it is offline."],
    useCases: ["retail-pos", "schools-and-computer-labs"],
    prd: "PRD 5.2, 9.4, 10",
  },
  {
    slug: "performance",
    name: "Light on old hardware",
    icon: "cpu",
    tone: "mint",
    headline: "4 GB is enough.",
    oneLine: "Rulebox trims Windows’ background load and keeps its own footprint small.",
    title: "Kiosk Software for 4 GB RAM PCs | Rulebox",
    description:
      "Lite mode, suspended windows and a trimmed Windows background. Rulebox is built and tested for 4 GB laptops.",
    points: [
      "Lite mode switches on by itself on PCs with 4 GB of RAM or less.",
      "Minimised web apps are suspended; idle ones close.",
      "Windows Defender and Windows Update stay on. Security is not traded for speed.",
    ],
    doesNotDo: [
      "It cannot make many heavy apps run at once on 4 GB. An SSD is still the biggest single improvement.",
    ],
    useCases: ["schools-and-computer-labs", "shared-staff-pcs"],
    prd: "PRD 22",
  },
  {
    slug: "files",
    name: "Files",
    icon: "folder",
    tone: "sun",
    headline: "Double-click and it opens. Safely.",
    oneLine: "PDFs, pictures, music, video and Office files open in Rulebox’s own viewers.",
    title: "Safe File Viewers on Locked PCs | Rulebox",
    description:
      "PDFs, pictures, music, video and Office previews open in Rulebox’s own viewers. Programs and scripts never open.",
    points: [
      "A simple file explorer that shows only the signed-in person’s folder.",
      "Programs and scripts never open, whatever their name.",
      "Storage quota per person, with a warning near the limit.",
    ],
    doesNotDo: [
      "Office files are preview-only; add LibreOffice or OnlyOffice for editing.",
      "The quota is “soft” in v1.",
    ],
    useCases: ["clinics-and-pharmacies", "shared-staff-pcs"],
    prd: "PRD 7, 8",
  },
  {
    slug: "branding",
    name: "Your brand",
    icon: "palette",
    tone: "coral",
    headline: "Your name on every screen.",
    oneLine: "Company name, logo, colours and wallpaper on the sign-in screen and desktop.",
    title: "Branded Kiosk Desktops for Windows | Rulebox",
    description:
      "Put your company name, logo, colours and wallpaper on the sign-in screen and the staff desktop of every PC.",
    points: [
      "Set the name, logo, colours and wallpaper once in the dashboard.",
      "Every enrolled PC shows them on the sign-in screen and the desktop.",
    ],
    doesNotDo: [],
    useCases: ["hotels-front-desk", "retail-pos"],
    prd: "PRD 3.1",
  },
  {
    slug: "wifi-and-printers",
    name: "Wi-Fi, printers and drivers",
    icon: "wifi",
    tone: "blue",
    headline: "Staff cannot open Settings. They do not need to.",
    oneLine: "Push Wi-Fi networks, printers and drivers from the dashboard, per group.",
    title: "Push Wi-Fi and Printers to Locked PCs | Rulebox",
    description:
      "Push Wi-Fi networks, printers and drivers from the dashboard, per group, to PCs where staff cannot open Settings.",
    points: [
      "Wi-Fi profiles pushed from the dashboard work at the sign-in screen.",
      "Receipt and label printers arrive with their drivers.",
      "Profiles are set per group, so each site gets its own.",
    ],
    doesNotDo: ["Printing from a web app is one of that web app\u2019s permissions. Allow it per web app."],
    useCases: ["retail-pos", "schools-and-computer-labs"],
    prd: "PRD 24.1, 24.2",
  },
  {
    slug: "lock-and-broadcast",
    name: "Lost-device lock and messages",
    icon: "bell",
    tone: "violet",
    headline: "Lost a laptop? Lock it from your chair.",
    oneLine: "A full-screen lock that survives restarts and works offline, plus banners to any group.",
    title: "Lock a Lost Laptop and Message Every Screen | Rulebox",
    description:
      "Lock a lost laptop from the dashboard with a full-screen lock that survives restarts, and send banners to any group.",
    points: [
      "The lock screen shows “This laptop belongs to …” and stays locked, even offline.",
      "It survives restarts.",
      "Send a banner to every screen in a group: “Maintenance at 5 pm. Please save your work.”",
    ],
    doesNotDo: [],
    useCases: ["clinics-and-pharmacies", "call-centres"],
    prd: "PRD 24.4",
  },
  {
    slug: "reversible",
    name: "Back to normal Windows",
    icon: "undo",
    tone: "mint",
    headline: "Never a one-way door.",
    oneLine: "Turn kiosk mode off and the PC behaves like normal Windows. Rulebox restores the settings it changed.",
    title: "Turn Kiosk Mode Off Any Time | Rulebox",
    description:
      "Turn kiosk mode off from the dashboard or at the PC, and Rulebox restores the Windows settings it changed.",
    points: [
      "From the dashboard, or with a hidden key combination and PIN at the PC.",
      "Uninstalling restores the normal Windows shell.",
      "Hold Shift at start-up to reach the Windows sign-in screen for recovery.",
    ],
    doesNotDo: [],
    useCases: ["shared-staff-pcs", "schools-and-computer-labs"],
    prd: "PRD 9.5, 12.4, 13.5",
  },
];

export const L1_FEATURES = ["lockdown", "staff-desktop", "employee-sign-in", "apps", "dashboard"];

export const featureBySlug = (slug: string) => FEATURES.find((f) => f.slug === slug);
