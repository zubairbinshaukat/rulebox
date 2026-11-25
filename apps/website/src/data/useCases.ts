/*
 * Use-case pages. Source: docs/website/story-and-copy.md §6.2-6.7 (Tier 1).
 * [EARLY-ACCESS RESULT] slots are left out on purpose: they ship only with real,
 * approved results (Story §1, plan §7.2).
 */
import type { IconName } from "../components/Icon.astro";
import type { Tone } from "./features";

export interface UseCase {
  slug: string;
  name: string;
  place: string;
  icon: IconName;
  tone: Tone;
  title: string;
  description: string;
  h1: string;
  sub: string;
  problem: string;
  moment: string;
  how: { text: string; feature?: string }[];
  outcome: string;
  limits?: string;
  faq: { q: string; a: string }[];
  related: string[];
  hub?: boolean;
}

export const USE_CASES: UseCase[] = [
  {
    slug: "shared-staff-pcs",
    hub: true,
    name: "Shared staff PCs",
    place: "Any shared workplace PC",
    icon: "users",
    tone: "mint",
    title: "Lock Down Shared Staff PCs on Windows | Rulebox",
    description:
      "One PC, many people. Rulebox gives each staff member their own sign-in, apps and files on a locked Windows desktop you manage from the web.",
    h1: "One PC. Many people. No mess.",
    sub: "Rulebox turns a shared Windows PC into a locked workstation where each person signs in and sees only what they need.",
    problem:
      "A shared PC collects everything. Saved passwords, personal downloads, half-installed toolbars, the last person’s email. No one is responsible for it, so it gets slower and less safe every month.",
    moment:
      "Monday, 9 am. The accounts PC shows a browser full of someone’s personal tabs. The accounting app has an update prompt that needs an admin password nobody has. The desktop holds forty files and no one knows whose they are.",
    how: [
      { text: "Each person signs in with their own details, on any Rulebox PC their group allows.", feature: "employee-sign-in" },
      { text: "They see only the apps assigned to them or their group.", feature: "apps" },
      { text: "Each person gets their own folder and their own web logins. Logging out closes their apps and clears their session.", feature: "files" },
      { text: "Staff have no admin rights. Apps and updates are installed by Rulebox, silently.", feature: "lockdown" },
    ],
    outcome: "The PC is the same on Friday as it was on Monday. Handover between people takes one log-out.",
    faq: [
      { q: "Can two people use the same PC with different apps?", a: "Yes. Apps are assigned per group and per person." },
      { q: "Do staff need a Microsoft account?", a: "No. They sign in to Rulebox with the details you give them in the dashboard." },
      {
        q: "Can someone sign in when the internet is down?",
        a: "Yes, if they have signed in on that PC before. You set how long offline sign-in stays valid.",
      },
      { q: "Do files follow a person from PC to PC?", a: "Not in v1. Files stay on the laptop where they were saved." },
    ],
    related: ["retail-pos", "clinics-and-pharmacies"],
  },
  {
    slug: "retail-pos",
    name: "Retail and POS",
    place: "Tills and back offices",
    icon: "shop",
    tone: "sun",
    title: "POS and Store PC Lockdown for Windows | Rulebox",
    description:
      "Keep till and back-office PCs on the job. Rulebox locks Windows PCs to your POS, web portals and approved apps, managed across every branch.",
    h1: "The till PC should only be a till.",
    sub: "Lock store PCs to your POS and the few tools staff need. Manage every branch from one dashboard.",
    problem:
      "The till PC handles money and customer data. It also has a browser, a USB port and a bored cashier on a slow afternoon. One bad download can stop sales for a day.",
    moment:
      "Saturday, the busiest hour. The POS freezes because something in the background is using all the memory. Nobody at the store can fix it. The owner is across town.",
    how: [
      { text: "Only the POS app and the tools you approve can run. Task Manager, the Run box, Command Prompt and Windows shortcuts are off for staff.", feature: "lockdown" },
      { text: "USB storage can be blocked by policy.", feature: "lockdown" },
      { text: "Web portals open in their own windows, limited to the domains you list.", feature: "apps" },
      { text: "Receipt and label printers are pushed from the dashboard, with their drivers.", feature: "wifi-and-printers" },
      { text: "New branch? Install, type the enrolment code, done. The PC pulls its apps and rules by itself.", feature: "dashboard" },
      { text: "Windows background load is trimmed on kiosk PCs, so a 4 GB machine has more room for the POS.", feature: "performance" },
    ],
    outcome: "Every till in every branch runs the same approved set. A change is tested on one PC before it reaches the rest.",
    limits:
      "Rulebox is not a POS and not a payment terminal. It does not make a store PCI DSS compliant by itself. It reduces what can run on the PC.",
    faq: [
      { q: "Will my POS software work?", a: "If it installs silently as an MSI or EXE, or runs as a web app, yes. Test it on one PC first." },
      {
        q: "Does Rulebox update my POS?",
        a: "You choose per app: keep a pinned version, let the vendor’s updater run, or let Rulebox manage versions with staged rollout.",
      },
      { q: "What if the store loses internet?", a: "The PC keeps working with its stored rules. Changes arrive when it reconnects." },
    ],
    related: ["hotels-front-desk", "call-centres"],
  },
  {
    slug: "schools-and-computer-labs",
    name: "Schools and computer labs",
    place: "Labs and exam rooms",
    icon: "school",
    tone: "blue",
    title: "Computer Lab and Exam PC Lockdown for Schools | Rulebox",
    description:
      "Lock lab PCs to lesson apps and approved websites. Rulebox is open source, runs on 4 GB PCs and puts every lab under one web dashboard.",
    h1: "A lab that is ready when the bell rings.",
    sub: "Lock school PCs to the lesson, the exam site or the library catalogue. Reset between classes by logging out.",
    problem:
      "Thirty PCs, six classes a day, one part-time IT teacher. The PCs are old. Students are curious.",
    moment:
      "Exam morning. Four PCs show yesterday’s class still signed in to a website. Two have a game installed. One will not start the exam site because someone changed the proxy.",
    how: [
      { text: "Each group sees its own apps. “Year 9” gets the typing tutor. “Exam room” gets one website.", feature: "apps" },
      { text: "Web apps are limited to listed domains. Everything else shows a clear “not allowed” page.", feature: "apps" },
      { text: "Per-site permissions: camera, microphone, clipboard and screen sharing are blocked unless you allow them.", feature: "apps" },
      { text: "Log-out closes apps and clears the session for the next class.", feature: "employee-sign-in" },
      { text: "Lite mode is chosen automatically on PCs with 4 GB of RAM or less.", feature: "performance" },
      { text: "Wi-Fi is pushed from the dashboard and works at the sign-in screen.", feature: "wifi-and-printers" },
    ],
    outcome: "The lab starts each lesson in the same state. Exam PCs open the exam site and nothing else.",
    limits:
      "Rulebox is not exam-proctoring software. It does not watch students or record screens. It limits what the PC can open. Use it with your exam platform, not in place of it.",
    faq: [
      { q: "Is it free for schools?", a: "The software is open source under the MIT licence. See the pricing page for the hosted service." },
      {
        q: "Does it work on Windows 10?",
        a: "The installer checks each PC and tells you. Note that Windows 10 support ended on 14 October 2025; the dashboard flags PCs whose Windows is out of support.",
      },
      {
        q: "Do students each need an account?",
        a: "You can give each student a sign-in, or use one sign-in per class. Sessions are cleared at log-out.",
      },
    ],
    related: ["shared-staff-pcs", "call-centres"],
  },
  {
    slug: "clinics-and-pharmacies",
    name: "Clinics and pharmacies",
    place: "Reception and dispensary",
    icon: "hospital",
    tone: "coral",
    title: "Locked Shared PCs for Clinics and Pharmacies | Rulebox",
    description:
      "Front-desk PCs see patient data all day. Rulebox locks them to your clinic system, gives each person their own sign-in and logs every admin change.",
    h1: "The front-desk PC sees everything. Keep it to one job.",
    sub: "A locked, shared workstation for reception, the dispensary and the nurses’ station.",
    problem:
      "A clinic PC is shared across shifts and shows patient records all day. A small clinic cannot afford a breach, and cannot afford an IT team either.",
    moment:
      "The evening receptionist sits down. The day receptionist’s webmail is still open next to the patient system. A USB stick someone found is in the port.",
    how: [
      { text: "Own sign-in per person. Separate web logins and cookies per person, never shared.", feature: "employee-sign-in" },
      { text: "Idle timeout that locks the screen or logs the person out.", feature: "staff-desktop" },
      { text: "Only the clinic system and approved tools can run.", feature: "lockdown" },
      { text: "Downloads from web apps go only to that person’s folder; executable files never open.", feature: "files" },
      { text: "An audit log of every administrative action: who, what, when.", feature: "dashboard" },
      { text: "A lost laptop can be locked from the dashboard.", feature: "lock-and-broadcast" },
    ],
    outcome: "No one inherits another person’s session. What can run on the PC is a short, known list.",
    limits:
      "Rulebox does not make a clinic compliant with HIPAA, GDPR or any other law by itself, and we hold no healthcare certification. It is one technical control. Desktop apps with their own file dialogs can still browse outside a person’s folder in v1.",
    faq: [
      { q: "Does Rulebox see patient data?", a: "No. Rulebox manages which apps run. Your clinic system’s data stays in that system." },
      {
        q: "Can the doctor’s own laptop stay normal?",
        a: "Yes. Only enrolled PCs are locked, and the admin account on each PC stays normal Windows.",
      },
    ],
    related: ["hotels-front-desk", "shared-staff-pcs"],
  },
  {
    slug: "call-centres",
    name: "Call centres",
    place: "Hot desks and shift floors",
    icon: "headphones",
    tone: "violet",
    title: "Agent PC Lockdown for Call Centres | Rulebox",
    description:
      "Hot desks, three shifts, one CRM. Rulebox locks agent PCs to approved apps and sites, with per-agent sign-in and staged updates across the floor.",
    h1: "Every seat ready for the next shift.",
    sub: "Lock agent PCs to the CRM, the softphone and nothing else. Any agent, any seat.",
    problem:
      "Hundreds of identical PCs, three shifts, high staff turnover. Clients ask what agents can copy, open and install. Each re-image costs a seat for half a day.",
    moment:
      "Shift change at 2 pm. Forty agents sit down at seats someone else just left. Six softphones are still signed in as the last agent.",
    how: [
      { text: "Any agent signs in at any enrolled PC and gets their own apps.", feature: "employee-sign-in" },
      { text: "Per-app “data folders to reset on logout”, so a desktop softphone forgets the last agent.", feature: "apps" },
      { text: "Clipboard read, downloads, camera and microphone are set per web app.", feature: "apps" },
      { text: "Rollout rings: Pilot, Early, Everyone. A bad change stops at the first ring.", feature: "updates-and-rollouts" },
      { text: "Removing a leaver takes effect on the PCs: a revoked-employees list is part of what each PC stores.", feature: "employee-sign-in" },
    ],
    outcome: "A seat is ready for the next agent after one log-out. Floor-wide changes are tested on a few seats first.",
    limits:
      "No screen recording, remote screen view or usage tracking in v1. These are planned for a later version, with privacy controls. Shift-hour sign-in limits are also planned.",
    faq: [
      { q: "Can any agent use any seat?", a: "Yes. Agents sign in at any enrolled PC their group allows and get their own apps." },
      { q: "Do you record agents’ screens?", a: "No. v1 has no screen viewing, no screenshots and no usage tracking." },
    ],
    related: ["shared-staff-pcs", "retail-pos"],
  },
  {
    slug: "hotels-front-desk",
    name: "Hotels and front desks",
    place: "Reception, every shift",
    icon: "bed",
    tone: "sun",
    title: "Front-Desk PC Lockdown for Hotels | Rulebox",
    description:
      "Lock front-desk and back-office PCs to your booking system and approved sites. Each shift signs in to a clean, branded desktop. Open source.",
    h1: "A front desk that looks the same on every shift.",
    sub: "Lock reception PCs to the booking system. Give each shift its own sign-in. Put your brand on the screen.",
    problem:
      "The front-desk PC runs day and night, across three shifts, with guest names and card details passing through. Night shifts are long and the PC has a browser.",
    moment:
      "3 am. A guest wants to check out. The property system will not open because the PC is busy installing something the night clerk downloaded.",
    how: [
      { text: "The desktop carries your name, logo, colours and wallpaper.", feature: "branding" },
      { text: "Only the property system, email and approved sites.", feature: "apps" },
      { text: "Own sign-in per clerk; sessions close at log-out.", feature: "employee-sign-in" },
      { text: "Power options (Sleep, Restart, Shut down) can be switched off per group, so the desk PC stays on.", feature: "staff-desktop" },
      { text: "Hidden admin exit: a key combination and a PIN, logged every time.", feature: "reversible" },
    ],
    outcome: "The same approved desktop at 3 pm and 3 am.",
    limits:
      "Rulebox is for staff PCs. For a guest-facing, single-screen check-in kiosk, Windows’ single-app kiosk mode is a better fit today.",
    faq: [
      { q: "Can the desk PC stay on all night?", a: "Yes. Sleep, Restart and Shut down can be switched off per group." },
      { q: "Can I put our hotel’s brand on it?", a: "Yes. Name, logo, colours and wallpaper are set in the dashboard." },
    ],
    related: ["clinics-and-pharmacies", "retail-pos"],
  },
];

/** Tier 2 and 3 places, shown on the hub and the home page without their own page yet. */
export const MORE_PLACES: { name: string; icon: IconName }[] = [
  { name: "Warehouses and factory floors", icon: "box" },
  { name: "NGOs and community centres", icon: "hand-heart" },
  { name: "Libraries and public PCs", icon: "library" },
  { name: "Government counters", icon: "city" },
];

export const useCaseBySlug = (slug: string) => USE_CASES.find((u) => u.slug === slug);
