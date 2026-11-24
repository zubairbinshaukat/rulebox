import { DEFAULT_DESCRIPTION, REPO_URL, SITE_NAME, SITE_URL } from "../config";

export interface PageMeta {
  title: string;
  description: string;
  /** Path without trailing slash, e.g. "/pricing". */
  path: string;
  type?: "website" | "article";
  noindex?: boolean;
  /** OG image key: /og/<key>.png */
  og?: string;
}

const TITLE_SUFFIX = ` | ${SITE_NAME}`;

/** Full <title>. Titles that already name Rulebox are kept as written. */
export function fullTitle(title: string): string {
  if (title.includes(SITE_NAME)) return title;
  return `${title}${TITLE_SUFFIX}`;
}

export function canonical(path: string): string {
  const clean = path === "/" ? "" : path.replace(/\/$/, "");
  return `${SITE_URL}${clean}`;
}

export function ogImageUrl(key = "default"): string {
  return `${SITE_URL}/og/${key}.png`;
}

export const DEFAULTS = { description: DEFAULT_DESCRIPTION };

/* ---------- JSON-LD helpers (plan §6.4) ---------- */

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
    sameAs: [REPO_URL],
  };
}

export function websiteLd() {
  return { "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME, url: SITE_URL };
}

/** Never add aggregateRating or review without real, visible reviews. */
export function softwareLd(version?: string) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "SecurityApplication",
    operatingSystem: "Windows",
    description: DEFAULT_DESCRIPTION,
    url: SITE_URL,
    license: "https://opensource.org/license/mit",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    ...(version ? { softwareVersion: version } : {}),
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: canonical(it.path),
    })),
  };
}

export function articleLd(opts: { type: "BlogPosting" | "TechArticle"; title: string; description: string; path: string; date?: string; author?: string }) {
  return {
    "@context": "https://schema.org",
    "@type": opts.type,
    headline: opts.title,
    description: opts.description,
    url: canonical(opts.path),
    ...(opts.date ? { datePublished: opts.date } : {}),
    ...(opts.author ? { author: { "@type": "Person", name: opts.author } } : {}),
  };
}
