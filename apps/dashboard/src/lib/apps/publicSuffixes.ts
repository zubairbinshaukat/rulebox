/**
 * A small public-suffix list (add-app plan section 6, D13): enough to find the "registrable domain" of an address
 * (`example.co.uk`, not `co.uk`) without shipping the whole list (~45 KB). It is used only to decide which levels the
 * site-access picker OFFERS and which typed entries it REFUSES; the PC itself never uses it (every allowed entry already
 * covers its subdomains). Lives in the website chunk only.
 *
 * Two kinds of entry: second-level suffixes of country domains, and hosting suffixes where the sites below belong to
 * different owners. A host not covered by the list falls back to a generic rule (see `publicSuffixOf`).
 */

/** Country-code second-level suffixes (the generic rule below covers `co`/`com`/... too; they are listed for clarity and for the odd names it misses). */
const COUNTRY_SUFFIXES = [
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk", "nhs.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp", "lg.jp",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.mx", "org.mx", "gob.mx", "edu.mx", "net.mx",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in", "res.in", "firm.in", "gen.in", "ind.in",
  "co.za", "org.za", "gov.za", "ac.za", "net.za", "web.za",
  "com.sg", "edu.sg", "gov.sg", "net.sg", "org.sg",
  "com.my", "net.my", "org.my", "gov.my", "edu.my",
  "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk",
  "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
  "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa",
  "com.eg", "net.eg", "org.eg", "gov.eg", "edu.eg",
  "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr",
  "com.hk", "org.hk", "net.hk", "edu.hk", "gov.hk",
  "com.tw", "org.tw", "net.tw", "edu.tw", "gov.tw",
  "com.ar", "net.ar", "org.ar", "gob.ar",
  "co.id", "or.id", "ac.id", "go.id", "web.id",
  "com.ph", "net.ph", "org.ph",
  "co.th", "ac.th", "or.th", "go.th", "in.th",
  "co.il", "org.il", "ac.il", "gov.il",
  "co.ae", "net.ae", "gov.ae", "ac.ae",
  "co.ke", "or.ke", "go.ke", "ac.ke",
  "com.ng", "org.ng", "gov.ng", "edu.ng",
  "com.bd", "net.bd", "org.bd",
  "com.ua", "org.ua", "com.pl", "org.pl", "net.pl",
];

/** Hosting suffixes whose subdomains belong to different owners (siblings must never be offered as "the same site"). */
const HOSTING_SUFFIXES = [
  "github.io", "gitlab.io", "githubusercontent.com",
  // Microsoft and Amazon hosting; `sharepoint.com` and `onmicrosoft.com` are one tenant per subdomain.
  "sharepoint.com", "onmicrosoft.com", "azurewebsites.net", "azurestaticapps.net", "azureedge.net", "cloudapp.azure.com",
  "cloudfront.net", "amazonaws.com", "elasticbeanstalk.com",
  // Developer platforms.
  "herokuapp.com", "vercel.app", "now.sh", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "appspot.com", "onrender.com", "fly.dev", "glitch.me", "repl.co", "surge.sh", "webflow.io", "notion.site",
  // Site builders and shops.
  "blogspot.com", "myshopify.com", "wixsite.com", "wordpress.com", "weebly.com",
  // Not on the public list, but customer sites live below them: a conservative choice.
  "atlassian.net", "zendesk.com", "freshdesk.com", "force.com", "my.salesforce.com",
  // Shared name services.
  "duckdns.org", "ddns.net", "uk.com", "us.com", "eu.com",
];

export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([...COUNTRY_SUFFIXES, ...HOSTING_SUFFIXES]);

/** With a 2-letter country domain, these labels in front of it form a suffix too (`co.xx`, `com.xx`, ...). */
const GENERIC_SECOND_LEVEL: ReadonlySet<string> = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc"]);

/**
 * The public suffix of a lower-case ASCII host: the longest entry of the list, else the generic rule (a 2-letter top level
 * with one of the labels above in front: both labels), else the last label. `localhost` is its own suffix.
 */
export function publicSuffixOf(host: string): string {
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (PUBLIC_SUFFIXES.has(candidate)) return candidate;
  }
  const tld = labels[labels.length - 1] ?? "";
  const before = labels[labels.length - 2];
  if (tld.length === 2 && before !== undefined && GENERIC_SECOND_LEVEL.has(before)) return `${before}.${tld}`;
  return tld;
}

/** True when the whole host is a public suffix (`co.uk`, `github.io`, `com`): allowing it would allow unrelated sites. */
export function isPublicSuffix(host: string): boolean {
  return publicSuffixOf(host) === host;
}
