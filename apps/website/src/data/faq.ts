/* FAQ copy. Source: Story §9. Items with an open [OWNER] or result slot are left out. */
import { SUPPORT_EMAIL } from "../config";

export const HOME_FAQ = [
  {
    q: "What is Rulebox?",
    a: "An open-source kiosk OS for Windows. It turns an ordinary PC into a locked, branded workstation. Staff sign in and can use only the apps, websites and files you approve. You manage everything from a web dashboard.",
  },
  {
    q: "Does it replace Windows?",
    a: "No. Rulebox runs on top of Windows. It replaces the Windows desktop for one special “Staff” account and locks that account down. The administrator account stays normal Windows.",
  },
  {
    q: "How is this different from Windows kiosk mode?",
    a: "Windows’ Assigned Access is solid and built in. It needs Pro or higher, is set up with an XML file through Intune, a provisioning package or PowerShell, and does not give you per-person sign-in, a web dashboard or staged rollouts. If you need one full-screen app on one screen, use it. If you need a shared staff desktop that you manage remotely, use Rulebox.",
  },
  {
    q: "Can staff get out?",
    a: "That is the main thing we test. Staff have no admin rights, only approved programs run, and each release is run against a 74-row escape checklist. No lockdown is perfect; if you find a way out, tell us through the security page.",
  },
  {
    q: "What happens if the internet goes down?",
    a: "Staff keep working. Rules, apps and sign-in details are stored on the PC. Changes you make arrive when it reconnects.",
  },
  {
    q: "Can I undo it?",
    a: "Yes. Turn kiosk mode off in the dashboard, or use the hidden admin exit at the PC. Uninstalling restores normal Windows.",
  },
  {
    q: "Do you watch what staff do?",
    a: "No. v1 has no screen viewing, no screenshots and no usage tracking. If these arrive later they will come with privacy controls.",
  },
  {
    q: "Does it support Android, macOS or Linux?",
    a: "Windows only today. Android is planned for v2. Linux is not planned.",
  },
  {
    q: "How do I get help?",
    a: `Email ${SUPPORT_EMAIL}. We reply by email. For a security problem, see the security page.`,
  },
];

export const SECURITY_FAQ = [
  {
    q: "The agent runs as SYSTEM. Why should I trust it?",
    a: "Fair question. The code is open under MIT, the agent is written in Rust, every installer it runs is hash-checked, and it rejects any policy that is not signed with your organisation’s key. Read the threat model in the docs.",
  },
  {
    q: "What if someone takes over our dashboard account?",
    a: "Dashboard sign-in needs a password and a PIN, and the dashboard locks again on every reopen. Passkeys are supported. Every action is in the audit log. Policies are signed, and publisher checks can be required for installers.",
  },
  {
    q: "Do you watch what staff do?",
    a: "No. v1 has no screen viewing, no screenshots and no usage tracking. If these arrive later they will come with privacy controls.",
  },
  {
    q: "Are you SOC 2 or ISO 27001 certified?",
    a: "No. We are a small open-source project. We publish how the system works and the code itself.",
  },
];

export const PRICING_FAQ = [
  {
    q: "How much does it cost?",
    a: "Self-hosting is free forever (MIT); it costs whatever your own backend costs. The hosted dashboard is paid, and free for organisations in the invite-only early access. Prices will be posted on the pricing page before early access ends.",
  },
  {
    q: "Is there a minimum number of PCs?",
    a: "No. Common device-management suites start at 10 or 15 devices; Rulebox has no minimum.",
  },
  { q: "Can I use it commercially?", a: "Yes. The MIT licence allows it." },
  {
    q: "Can I host it myself?",
    a: "Yes. You need your own Convex deployment. A one-command setup is planned.",
  },
  {
    q: "How do I join early access?",
    a: `Leave your email on the early-access page and tick “I want to try it now”. We reply by email. Questions? Write to ${SUPPORT_EMAIL}.`,
  },
];
