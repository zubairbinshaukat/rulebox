import type { EntryProblem, DecisionReason, SampleKind } from "../apps/siteAccess";

/**
 * The text of the site-access picker and its live preview (add-app plan sections 6 and 9). The picker rides the website
 * form's lazy chunk. Entries are shown in plain words ("example.com and everything under it"); the rules stay in the (i).
 */
export const appSiteAccessStrings = {
  label: "Which pages open",
  info: "Employees can open this site and everything under it. Choose how much of the site, and add other sites it needs, such as a sign-in page.",
  noAddress: "Type the address first.",
  invalidAddress: "Type a full website address, starting with https://.",
  only: (host: string) => `Only ${host}`,
  all: (domain: string) => `All of ${domain}`,
  allHint: (a: string, b: string) => `also ${a}, ${b} and the rest`,
  single: (domain: string) => `${domain} and everything under it opens`,
  ip: "Only this address opens",
  wildcardNote: "(*) was saved with a star; it works the same as the plain name.",
  others: "Other sites it needs",
  othersInfo: "Sign-in pages and payment pages are often on another site.",
  suggest: "Add a common sign-in service",
  suggestions: {
    microsoft: "Microsoft sign-in",
    google: "Google sign-in",
  },
  addLabel: "Add a site",
  addPlaceholder: "login.example.com",
  addButton: "Add",
  addHint: "A site name like login.example.com. Everything under it opens too.",
  remove: (entry: string) => `Remove ${entry}`,
  included: "(already included)",
  max: "Up to 20 other sites.",
  none: "No other sites.",
  errors: {
    empty: "Type a site name.",
    port: "Ports can't be added here.",
    local: "That address is on the local network.",
    ip_private: "That address is on the local network.",
    suffix: (suffix: string) => `That would allow every site ending in .${suffix}. Add the full site name.`,
    format: "That isn't a site name. Use something like login.example.com.",
    duplicate: "That site is already in the list.",
  } satisfies Record<EntryProblem | "duplicate", string | ((s: string) => string)>,
  /** The drawn address above the choices (the real control is the radio group below it). */
  drawn: {
    anything: "Any name here also opens",
  },
  /** The website form around the picker (`WebAppForm`). */
  form: {
    found: "Found the name and icon.",
    foundName: "Found the name.",
    iconAlt: "The site's icon",
    iconSaved: "This icon is saved with the app.",
  },
  // ---- the live preview
  preview: {
    title: "What employees can open",
    open: "Opens",
    blocked: "Blocked",
    summary: (open: number, blocked: number) => `${open} open, ${blocked} blocked`,
    try: "Try an address",
    tryPlaceholder: "mail.example.com",
    tryOpen: "Opens",
    tryBlocked: "Blocked",
    browserNote: "In Edge or Chrome, all browser websites on a PC share one list.",
    pathNote: (path: string) => `Every page of the site opens, not only ${path}.`,
    portNote: (port: number) => `Only port ${port} opens. The same name without that port is blocked.`,
    reasons: {
      own_host: "the website itself",
      entry: "allowed",
      not_https: "not secure",
      login: "has a sign-in in the address",
      port: "another port",
      not_listed: "another website",
      bad_address: "not an address",
    } satisfies Record<DecisionReason, string>,
    kinds: {
      start: "start page",
      page: "another page",
      sub: "a sub-address",
      sibling: "a sibling",
      parent: "the main domain",
      extra: "another site you added",
      other: "another website",
      http: "the unsecured form",
    } satisfies Record<SampleKind, string>,
  },
} as const;
