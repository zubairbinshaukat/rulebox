import { DEFAULT_DESCRIPTION, INSTAGRAM_URL, REPO_URL, SITE_NAME, SITE_URL, SUPPORT_EMAIL } from "../config";
import { SCREENS, SCREEN_SIZE, screenUrl } from "../data/screens";

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
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/icon-512.png`,
    sameAs: [REPO_URL, INSTAGRAM_URL],
    email: SUPPORT_EMAIL,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: SUPPORT_EMAIL,
      availableLanguage: "English",
    },
  };
}

/** Google's site name comes mainly from this block on the home page (developers.google.com/search/docs/appearance/site-names). */
export function websiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: SITE_NAME,
    alternateName: [`${SITE_NAME} Kiosk OS`, "rulebox.org"],
    url: `${SITE_URL}/`,
    publisher: { "@id": `${SITE_URL}/#organization` },
  };
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
    // Product screenshots only (never stock photos): drawn Staff App screens.
    screenshot: Object.values(SCREENS).map((s) => ({
      "@type": "ImageObject",
      url: `${SITE_URL}${screenUrl(s.key)}`,
      width: SCREEN_SIZE.width,
      height: SCREEN_SIZE.height,
      caption: s.alt,
    })),
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

/** The project as an organisation: publisher, and author where no person signs. */
export function publisherLd() {
  return {
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/icon-512.png`, width: 512, height: 512 },
  };
}

export function articleLd(opts: {
  type: "BlogPosting" | "TechArticle" | "Article";
  title: string;
  description: string;
  path: string;
  date?: string;
  modified?: string;
  /** Absolute image URL (the page's social card). */
  image?: string;
  /** A person's name, or omitted for the project (Organization). */
  author?: string;
  authorIsOrg?: boolean;
  keywords?: string[];
}) {
  const author = opts.author
    ? opts.authorIsOrg
      ? { "@type": "Organization", name: opts.author, url: SITE_URL }
      : { "@type": "Person", name: opts.author }
    : undefined;
  return {
    "@context": "https://schema.org",
    "@type": opts.type,
    headline: opts.title,
    description: opts.description,
    url: canonical(opts.path),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical(opts.path) },
    inLanguage: "en-GB",
    ...(opts.image ? { image: [opts.image] } : {}),
    ...(opts.date ? { datePublished: opts.date } : {}),
    ...(opts.modified ?? opts.date ? { dateModified: opts.modified ?? opts.date } : {}),
    ...(author ? { author } : {}),
    ...(opts.keywords?.length ? { keywords: opts.keywords.join(", ") } : {}),
    publisher: publisherLd(),
  };
}