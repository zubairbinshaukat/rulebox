import { APP_URL, REPO_URL } from "../config";

export interface NavLink {
  label: string;
  href: string;
  note?: string;
}

export const PRODUCT_MENU: NavLink[] = [
  { label: "How it works", href: "/product", note: "The agent, the staff desktop and the dashboard" },
  { label: "Lockdown", href: "/features/lockdown", note: "Locked means locked" },
  { label: "Staff desktop", href: "/features/staff-desktop", note: "Feels like Windows, only simpler" },
  { label: "Employee sign-in", href: "/features/employee-sign-in", note: "Any person, any Rulebox PC" },
  { label: "Apps and web apps", href: "/features/apps", note: "Installed for you, hash-checked" },
  { label: "Dashboard", href: "/features/dashboard", note: "Every PC, one web page" },
  { label: "All features", href: "/features" },
];

export const USE_CASE_MENU: NavLink[] = [
  { label: "Shared staff PCs", href: "/use-cases/shared-staff-pcs", note: "One PC, many people" },
  { label: "Retail and POS", href: "/use-cases/retail-pos" },
  { label: "Schools and labs", href: "/use-cases/schools-and-computer-labs" },
  { label: "Clinics and pharmacies", href: "/use-cases/clinics-and-pharmacies" },
  { label: "Call centres", href: "/use-cases/call-centres" },
  { label: "Hotels and front desks", href: "/use-cases/hotels-front-desk" },
  { label: "All use cases", href: "/use-cases" },
];

export const HEADER_LINKS: NavLink[] = [
  { label: "Docs", href: "/docs" },
  { label: "Pricing", href: "/pricing" },
  { label: "Open source", href: "/open-source" },
];

export const SIGN_IN: NavLink = { label: "Sign in", href: APP_URL };

export const FOOTER_COLUMNS: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/product" },
      { label: "Features", href: "/features" },
      { label: "Pricing", href: "/pricing" },
      { label: "Download", href: "/download" },
      { label: "Roadmap", href: "/roadmap" },
    ],
  },
  {
    title: "Use cases",
    links: [
      { label: "Shared staff PCs", href: "/use-cases/shared-staff-pcs" },
      { label: "Retail and POS", href: "/use-cases/retail-pos" },
      { label: "Schools and labs", href: "/use-cases/schools-and-computer-labs" },
      { label: "Clinics", href: "/use-cases/clinics-and-pharmacies" },
      { label: "Call centres", href: "/use-cases/call-centres" },
      { label: "Hotels", href: "/use-cases/hotels-front-desk" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Kiosk mode compared", href: "/compare/windows-kiosk-mode" },
      { label: "Changelog", href: "/changelog" },
      { label: "Blog", href: "/blog" },
      { label: "Numbers and sources", href: "/numbers" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Open source", href: "/open-source" },
      { label: "Source code", href: REPO_URL },
      { label: "Security", href: "/security" },
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Terms", href: "/legal/terms" },
      { label: "Cookies", href: "/legal/cookies" },
      { label: "Licences", href: "/legal/licenses" },
    ],
  },
];
