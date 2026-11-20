# Rulebox public website — build plan (Next.js on Cloudflare)

**Status:** Draft 1, not started · **Written:** 2026-11-21
**Content source:** `docs/website/story-and-copy.md` (cited below as
"Story §n")
**Scope:** plan only. No code is written by this document.

> This file is not yet listed in `docs/plans/README.md`. Add a row when
> the owner approves it.

## Contents

1. Goals, non-goals and decisions already made
2. Key findings from research (read these first)
3. Hosting and architecture (recommendation and options)
4. Site map
5. Per-page purpose and content source
6. SEO technical plan
7. Content workflow
8. Docs tooling
9. Analytics
10. Forms, Turnstile and Resend
11. Download page
12. Cloudflare setup
13. Performance and accessibility
14. Repository layout and project rules
15. Phased build steps with verification
16. Risks
17. Open questions for the owner
18. Sources

---

## 1. Goals, non-goals and decisions already made

### 1.1 Goals

| # | Goal | How we know it is met |
|---|---|---|
| G1 | Explain Rulebox to a non-technical owner in under a minute | Home page passes a five-second test with three people outside the project **(owner runs it)** |
| G2 | Turn interest into pilot requests | `/pilot` form works end to end; requests arrive by email |
| G3 | Earn trust without fake proof | Zero invented numbers; every number links to a source (Story §1, §7) |
| G4 | Be found in search for kiosk and shared-PC problems | Pages indexed; impressions grow in Search Console |
| G5 | Give technical readers docs, a download and the source | `/docs`, `/download`, `/open-source` live |
| G6 | Be fast and accessible | Budgets in Section 13 pass in CI |
| G7 | Cost nothing, or close to it, to run | Fits Cloudflare's free plans (Section 3) |

### 1.2 Non-goals

- Colours, visual style and layouts (a separate design pass).
- The customer dashboard (`app.<domain>`) and the operator console
  (`admin.<domain>`). The website links to the first and **never** to
  the second.
- Self-service sign-up. The pilot is invite-only.
- A CMS. Content lives in the repository.
- Any use of the Convex database by the website (see 1.4).

### 1.3 Decisions already made by the owner

| Decision | Detail |
|---|---|
| Framework | Next.js, App Router, in the monorepo at `apps/website/` |
| Host | Cloudflare (hosting, DNS, Turnstile, WAF) |
| Domains | Main domain = website · `app.<domain>` = dashboard · `admin.<domain>` = operator console (not linked, not in the sitemap) |
| Docs | At `/docs` on the main domain, written in MDX |
| Blog | MDX in the repository |
| Sign-up | Invite-only during the pilot |
| Design | Not decided here |

### 1.4 A rule this plan adds: the website does not touch Convex

`CLAUDE.md` says database reads and writes are a tight budget on the
Convex free tier. A public website attracts bots. So:

- Form submissions go to email (Resend), not to Convex.
- No page reads Convex at build time or run time.
- When sign-up opens, the website only links to `app.<domain>`.

---

## 2. Key findings from research (read these first)

Five things found on 2026-11-21 change how this site should be built.

| # | Finding | Source | Effect on the plan |
|---|---|---|---|
| F1 | **Cloudflare now recommends "vinext", not OpenNext,** as "the default way to run Next.js applications on Cloudflare Workers". OpenNext is listed as the path for existing OpenNext apps. The old `next-on-pages` adapter is no longer mentioned. vinext is "in beta" and is a re-implementation of the Next.js API on Vite, not Next.js itself | <https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/> | The owner's two options ("OpenNext or Pages") are both no longer Cloudflare's first choice. See Section 3 |
| F2 | **Workers Free allows 10 ms of CPU time per request** and 100,000 requests per day. OpenNext's Worker must also stay under **3 MiB compressed** on the free plan (10 MiB on paid) | <https://developers.cloudflare.com/workers/platform/limits/> · <https://opennext.js.org/cloudflare> | Server-rendering Next.js inside a free Worker is tight. Static files avoid the problem |
| F3 | **"Requests to static assets are free and unlimited"** on Workers, with up to 20,000 files of up to 25 MiB each on the free plan | <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/> · limits page above | A fully static site costs nothing and has no request cap |
| F4 | **OpenNext says Windows support is not guaranteed.** The dev machine is Windows 11 | <https://opennext.js.org/cloudflare> | If OpenNext is used, its build must run in CI (Linux), not on the dev machine |
| F5 | **Google no longer shows FAQ rich results.** Google's page states "The FAQ rich result feature is no longer shown in Google Search results" (June 2026 entry) | <https://developers.google.com/search/docs/appearance/structured-data/faqpage> | FAQ blocks are written for readers. FAQPage markup is optional, not a traffic lever |

Supported Next.js versions on OpenNext today: "All minor and patch
releases of Next.js 16, and the latest minor of Next.js 15."

---

## 3. Hosting and architecture

### 3.1 The site is content, so build it as static files

Every page in Section 4 can be produced at build time. Only three things
need code that runs on a request: two forms and a waitlist email field.

### 3.2 Options

| | **A. Static export + one small Worker** | **B. Full Next.js on Workers via OpenNext** | **C. vinext** |
|---|---|---|---|
| What it is | `output: 'export'` writes plain HTML/CSS/JS to `out/`. One Worker serves those files and runs a small hand-written handler for `/api/*` (forms) | The whole Next.js server runs inside a Worker through `@opennextjs/cloudflare` | Cloudflare's Vite-based re-implementation of Next.js |
| Is it "real" Next.js? | Yes. Official feature | Yes | No. An API-compatible rebuild, "in beta" |
| Cost | Free. Static requests are unlimited (F3). Only form posts use the Worker | Free plan: 10 ms CPU and 3 MiB limits are a real risk (F2). Likely needs Workers Paid **(price not checked today; about $5 a month from memory)** | Unknown |
| Builds on Windows | Yes, a normal `next build` | Not guaranteed (F4); build in CI | Not checked |
| App Router, Server Components, Metadata API, MDX | Yes, all at build time | Yes | Mostly ("Mostly supported" `next/*` imports) |
| `sitemap.ts`, `robots.ts`, OG image files | Yes, as static GET handlers. **Verify OG image generation in Step 2** | Yes | Unknown |
| Not available | Middleware/proxy, redirects and headers in `next.config`, ISR, Server Actions, default image optimiser, POST route handlers (Next.js docs list) | Nothing important | Gaps in newer features |
| Replacements needed | Redirects and headers → Cloudflare `_redirects` and `_headers` files. Images → sized at build time. Forms → the small Worker | None | — |
| Docs (Fumadocs) | Supported with a static search index (Section 8) | Supported | A community guide exists; not read |
| Lock-in | None. `out/` runs on any static host | Tied to the adapter | Tied to Cloudflare's project |

### 3.3 Recommendation

**Option A: static export plus one small Worker.**

Reasons, in order:

1. The site has no page that needs a server. Paying the cost of a server
   runtime (CPU limits, bundle limits, adapter updates) buys nothing.
2. It is free with no request cap, and it is the fastest option: the
   edge returns a file.
3. It builds on the Windows dev machine with no adapter.
4. Cloudflare has just changed its recommended adapter (F1). A static
   site does not care which adapter wins.
5. It is still App Router, Server Components, the Metadata API and MDX.
   Nothing is thrown away if the site later needs a server.

**The portability rule.** Write the app so that moving to option B is a
config change, not a rewrite:

- No page uses request-time data (cookies, headers, search params on the
  server).
- Every dynamic route has `generateStaticParams`.
- Form handling lives behind one interface (`/api/pilot`,
  `/api/contact`, `/api/notify`), so the handler can move from the
  hand-written Worker to a Next.js route handler later.

**When to switch to B:** if the site gains logged-in pages, per-request
personalisation, or content that must update without a rebuild.

This departs slightly from the owner's wording ("Workers via OpenNext or
Pages"). It is Question Q1 in Section 17.

### 3.4 Architecture (option A)

```
Browser
  │
  ▼
Cloudflare (DNS, TLS, WAF, cache)
  │
  ├── any path ──────────► Worker static assets  (apps/website/out/)   free, unlimited
  │                         html_handling + 404 page
  │
  └── /api/*  ───────────► Worker script (apps/website/worker/)
                              1. check Turnstile token (siteverify)
                              2. validate fields, honeypot, rate limit
                              3. send email through Resend
                              4. return JSON

Build (GitHub Actions or Cloudflare Workers Builds)
  pnpm --filter @rulebox/website build   →  out/
  wrangler deploy                        →  Worker + assets

Release hook
  A new Rulebox release on GitHub ──► triggers a website rebuild
  (so /download and /changelog show the new version)
```

Routing detail to verify in Step 1: with a Worker script and static
assets in one Worker, asset requests are served without running the
script unless `run_worker_first` is set for a path. Set it only for
`/api/*` so page views never count against the 100,000 daily requests.

---

## 4. Site map

Launch phases: **L1** = first public launch · **L2** = use cases and
comparisons · **L3** = content library · **L4** = later.

```
/                                   L1  Home
/product                            L1  How it works (the full story)
/windows-kiosk-software             L2  Pillar guide (category keyword)

/features                           L1  Feature index
/features/lockdown                  L1
/features/staff-desktop             L1
/features/employee-sign-in          L1
/features/apps                      L1
/features/dashboard                 L1
/features/updates-and-rollouts      L2
/features/offline                   L2
/features/performance               L2
/features/files                     L2
/features/branding                  L2
/features/wifi-and-printers         L2
/features/lock-and-broadcast        L2
/features/reversible                L2

/use-cases                          L1  Index (by place, by job)
/use-cases/shared-staff-pcs         L1  Hub page
/use-cases/retail-pos               L2
/use-cases/schools-and-computer-labs L2
/use-cases/clinics-and-pharmacies   L2
/use-cases/call-centres             L2
/use-cases/hotels-front-desk        L2
/use-cases/warehouses-and-factories L3
/use-cases/ngos-and-community-centres L3
/use-cases/libraries-public-pcs     L3
/use-cases/government-counters      L3
/use-cases/restaurants              L4
/use-cases/events-check-in          L4
/use-cases/training-centres         L4

/compare                            L2  Index
/compare/windows-kiosk-mode         L2
/compare/intune                     L3
/compare/hexnode                    L3
/compare/scalefusion                L3
/compare/surelock                   L4  (research first)
/compare/deep-freeze                L4  (research first)

/pricing                            L1
/pilot                              L1  Request an invite (form)
/download                           L1
/open-source                        L1
/security                           L1  Trust page
/security/disclosure                L1  How to report a problem
/numbers                            L2  Every number on the site, with its source
/roadmap                            L1
/changelog                          L1
/changelog/[version]                L2

/docs                               L1  (structure in Section 8)
/docs/...

/blog                               L2
/blog/[slug]                        L2
/blog/rss.xml                       L2
/guides                             L3
/guides/[slug]                      L3
/glossary                           L3
/glossary/[term]                    L3

/about                              L1
/contact                            L1  (form)
/brand                              L3  Logo files and usage rules
/why-rulebox                        L4  One-page brief to forward to a boss

/legal/privacy                      L1
/legal/terms                        L1
/legal/cookies                      L1  (short: we set none; see Section 9)
/legal/licenses                     L1  Third-party notices
/legal/sub-processors               L2

/404                                L1
/sitemap.xml  /robots.txt  /llms.txt  /.well-known/security.txt   L1
```

Never on this site: any link to `admin.<domain>`.

Navigation (content only; the design pass decides the look):

- **Header:** Product ▾ (How it works, features) · Use cases ▾ (by
  place, by job) · Docs · Pricing · Open source · Sign in · **Request a
  pilot invite**
- **Footer columns:** Product · Use cases · Compare · Resources (Docs,
  Blog, Guides, Glossary, Changelog, Roadmap) · Company (About, Contact,
  Brand, Security) · Legal

---

## 5. Per-page purpose and content source

| Page | Purpose | Reader | Content source | Primary action |
|---|---|---|---|---|
| Home | Tell the six-beat story; route people | All | Story §5, blocks `core.*` (§13), strip A (§7.4), latest 3 changelog entries | Request a pilot invite |
| Product | The full story and the three parts | Owner, IT | Story §5, `core.what`, `core.how` | See features / pilot |
| Pillar guide | Rank for the category; teach honestly | Searchers | Story §12.2 row, §11.1, glossary | Compare / pilot |
| Feature pages | One feature, its limits, its docs | IT | Story §8.2 (F1–F13), truth table §8.1 | Read the doc / pilot |
| Use-case hub | "Shared PCs" problem and all industries | Owner | Story §6.2 | Pick an industry / pilot |
| Industry pages | Problem, moment, solution, outcome | Owner, IT | Story §6.3–6.12, template §6.13 | Pilot |
| Compare pages | Fair choice between tools | IT | Story §11 (each fact re-checked and dated) | Pilot / docs |
| Pricing | Say what is free, what is pilot, what is coming | All | Story §9.3 | Pilot / self-host |
| Pilot | Collect invite requests | Owner, IT | Story §9.3, form spec Section 10 | Submit |
| Download | Installer, checksum, how to verify | IT | GitHub Releases (Section 11) | Download |
| Open source | Why open, how to self-host, how to help | Evaluator, contributor | Story §10.1 | View the source |
| Security | Threat model, layers, tests, limits | Evaluator | Story §10.2, PRD 12 and 13 | Read docs / report |
| Numbers | Source for every number | Sceptics, press | Story §7 | — |
| Roadmap | Built, next, later, not planned | All | PRD 17, 18, 19; Story §8.1 | Notify me |
| Changelog | Proof of life | All | `CHANGELOG` MDX or GitHub Releases | — |
| Docs | Teach setup and operation | IT, contributor | New MDX; draws on PRD and `docs/guides/*` when those exist | — |
| Blog | Story and engineering posts | All | Story §12.4 list | Subscribe / pilot |
| Guides | How-to content for search | Searchers | Story §12.4 list | Pilot |
| Glossary | Definitions for search | Searchers | Story §12.4 list | Related feature |
| About | Who builds it and why | All | **[OWNER]** | Contact |
| Contact | General and security contact | All | Section 10 | Submit |
| Legal | Privacy, terms, licences | All | **[OWNER]**; `THIRD_PARTY_NOTICES.md` | — |

---

## 6. SEO technical plan

### 6.1 Metadata API

- **Root layout:** `metadataBase` (the production origin), a title
  template `"%s | Rulebox"` with a default, default description, Open
  Graph and Twitter defaults, `alternates.canonical`.
- **Every page** exports `metadata`, or `generateMetadata` for MDX
  routes, built by one helper: `pageMeta({ title, description, path,
  type, noindex? })`. The helper sets the canonical URL, Open Graph URL,
  and the right OG image.
- **Source of titles and descriptions:** Story §12.2 and §6. They are
  stored with the content (front matter), not typed into components.
- **Checks in CI:** every page has a unique title (≤ 60 characters
  warning) and description (70–160 characters warning), exactly one H1,
  a canonical URL.

### 6.2 Canonical URLs and duplicates

- One origin only: `https://<domain>`. `www` redirects to it (or the
  reverse; **[OWNER]** choose) with a Cloudflare redirect rule.
- **Trailing slash:** pick one and keep it. Recommendation:
  `trailingSlash: false`, with Cloudflare's asset handling set so
  `/pricing` serves `pricing.html` and `/pricing/` redirects to
  `/pricing`. **Verify in Step 1.**
- Preview deployments (`*.workers.dev`) send
  `X-Robots-Tag: noindex` and their `robots.txt` disallows everything.
- `app.<domain>` and `admin.<domain>` send `noindex` themselves (a task
  for those apps; note it for the dashboard and console plans).
- UTM parameters never appear in canonical URLs.

### 6.3 `sitemap.xml` and `robots.txt`

- `app/sitemap.ts` builds the list from the content collections and the
  static routes, with `lastModified` from Git commit dates. Static
  export supports this as a static GET handler.
- Leave out: `/pilot` thank-you state, `/404`, anything `noindex`.
- `app/robots.ts`: allow all, point to the sitemap. On non-production
  builds: disallow all.
- **AI crawlers:** decide deliberately (Q8). Recommendation: allow them.
  A new product gains from being quoted in AI answers. Publish
  `/llms.txt` (a plain index of the docs and key pages).
- Submit the sitemap in Google Search Console and Bing Webmaster Tools.
  Verify both through DNS records on Cloudflare.

### 6.4 Structured data (JSON-LD)

One helper renders a `<script type="application/ld+json">` per page.

| Type | Where | Notes |
|---|---|---|
| `Organization` | Home | Name, URL, logo, `sameAs` (GitHub and real social profiles only) |
| `WebSite` | Home | Name and URL |
| `SoftwareApplication` | Home, `/product`, `/download` | `applicationCategory: "SecurityApplication"` (or `BusinessApplication`), `operatingSystem: "Windows 10, Windows 11"` (match the real minimum build), `offers` with price `0`, `softwareVersion` from the latest release, `license` URL. **Never** add `aggregateRating` or `review` without real, visible reviews |
| `BreadcrumbList` | Every page below home | Matches the visible breadcrumb |
| `BlogPosting` | Blog posts | Author is a real person; dates from front matter |
| `TechArticle` | Docs and guides | — |
| `DefinedTerm` | Glossary | Inside a `DefinedTermSet` |
| `FAQPage` | Optional | Google no longer shows FAQ rich results (F5). Add it only if cheap; it may still help other search engines and AI assistants **(unverified)**. The visible FAQ is what matters |

Validate with Google's Rich Results Test and the Schema.org validator
before launch.

### 6.5 Open Graph images

- Size 1200×630. One default image, plus a generated image per use
  case, feature, blog post and doc section, showing the page title.
- Approach: `opengraph-image.tsx` files using `ImageResponse` from
  `next/og`, generated at build time. **Verify in Step 2 that these
  build under `output: 'export'`.** Fallback: a small build script that
  renders the same template to PNG files in `public/og/`.
- `ImageResponse` supports flexbox only, not CSS grid (Next.js docs).
  Bundle the Figtree font file for it; do not fetch fonts at build time
  from a CDN.
- The look of the card belongs to the design pass.

### 6.6 Core Web Vitals budgets

Thresholds are Google's "good" values at the 75th percentile (LCP ≤ 2.5
s, INP ≤ 200 ms, CLS ≤ 0.1; from memory of web.dev, stable since 2024).
Our budgets are stricter.

| Metric | Budget (mobile, mid-range phone, slow 4G) | How |
|---|---|---|
| LCP | ≤ 1.8 s | Static HTML from the edge; hero is text or one preloaded image |
| INP | ≤ 100 ms | Very little client JavaScript; no heavy handlers |
| CLS | ≤ 0.02 | Width and height on all media; fonts with size-adjusted fallbacks |
| First-load JavaScript, marketing pages | ≤ 100 kB compressed | Server Components by default; client components only for menu, form, search |
| First-load JavaScript, docs pages | ≤ 160 kB compressed | Search loads on first use |
| HTML per page | ≤ 60 kB compressed | — |
| Fonts | 2 files, ≤ 90 kB total | Figtree variable and a Geist Mono subset, self-hosted |
| Largest image | ≤ 120 kB | AVIF with WebP fallback, sized at build time |
| Third-party scripts | 1 (analytics), plus Turnstile on form pages only | — |
| Lighthouse (mobile) | Performance ≥ 95, Accessibility 100, Best Practices 100, SEO 100 | CI gate on five key pages |

### 6.7 Images without the Next.js optimiser

Static export cannot use the default image optimiser. Use
`images: { unoptimized: true }` and prepare images at build time: a
script (or an image import plugin) writes AVIF and WebP at two or three
widths; a small `<Picture>` component outputs `srcset`, `sizes`, width
and height. Screenshots of the product are the main images; capture
them at fixed sizes. SVG for the logo and diagrams.

### 6.8 i18n readiness (English only at launch)

- Do not add a `[lang]` URL prefix now. English stays at the root.
- Keep every string in content files or one dictionary, never inline in
  components.
- Content folders are locale-ready: `content/en/...` from day one.
- Later, other languages live under `/<lang>/...` with `hreflang`
  alternates and `x-default` from the same `pageMeta` helper. Static
  export has no middleware, so there is no automatic language redirect;
  use a visible language switcher.
- Use CSS logical properties (`margin-inline`, `padding-inline`) so a
  right-to-left language needs no layout rewrite. (A note for the design
  pass.)
- Which languages, and when, is Q9.

### 6.9 Other technical SEO

- Semantic HTML: one H1, ordered headings, `<nav>`, `<main>`, `<footer>`.
- Descriptive link text; breadcrumbs; no orphan pages (CI check counts
  inbound links per page, Story §12.3).
- A link checker in CI for internal links and anchors; a weekly job for
  external links (sources go stale).
- 301 redirects in `_redirects`, kept in the repo. A slug never changes
  without a redirect.
- RSS feed for blog and changelog.
- A real 404 page with links and search; correct 404 status **(verify
  with static assets in Step 1)**.

---

## 7. Content workflow

### 7.1 Where content lives

```
apps/website/
  content/
    en/
      blocks/         reusable copy blocks (Story §13) as typed data
      use-cases/      one MDX file per page (front matter + body)
      features/
      compare/
      blog/
      guides/
      glossary/
      changelog/
      legal/
      docs/           the /docs tree
    numbers.ts        every number: value, label, kind, source URL, checked date
    claims.ts         the truth table (Story §8.1): claim, PRD ref, status
```

- **Typed front matter.** A schema (Zod, through the docs tool's
  collections or a small loader) validates every file at build time:
  `title`, `description`, `h1`, `primaryKeyword`, `updated`, `status`,
  `related[]`, `faq[]`, `sources[]`.
- **Numbers are data.** A page shows a number with
  `<Stat id="mem-idle" />`. The component prints the value, the label
  and a link to its source. No number is typed into a page by hand.
- **Feature status is data.** `<Status claim="android" />` prints
  "Coming in v2" from `claims.ts`. When a feature ships, one line
  changes and every page follows.

### 7.2 Honesty gates (the build fails if...)

| Gate | Rule |
|---|---|
| Placeholders | Any `[PILOT RESULT`, `[RELEASE RESULT`, `[OWNER` string in a page that is not marked `draft: true` |
| Numbers | A `<Stat>` whose entry has no source, or a `checked` date older than 12 months |
| Comparisons | A competitor fact with no source URL and "checked on" date |
| Claims | A page that uses a claim whose status is not `v1` without a status label |
| Banned words | The list in Story §4.5 (warning, not failure) |

### 7.3 Authoring and review

1. Writer opens a branch and adds or edits MDX.
2. Pull request gets a preview URL (Section 12).
3. Checks run: typecheck, lint, content schema, honesty gates, links,
   spelling, Lighthouse on changed pages.
4. **Two reviews for public claims:** a product-truth review (is it in
   the PRD and in the release?) and a plain-English review (short
   sentences, no banned words).
5. Merge to `main` deploys.

Per `CLAUDE.md`: commits use the owner's Git identity, and nothing is
pushed without the owner's go-ahead.

### 7.4 Keeping it fresh

| When | What |
|---|---|
| Every Rulebox release | Changelog entry; `claims.ts` review; `softwareVersion`; download page rebuilds itself |
| Quarterly | Re-check competitor facts and prices; re-check cited statistics; update "checked" dates |
| When the PRD changes | Review `claims.ts` and the feature pages it touches |
| End of pilot | Replace **[PILOT RESULT]** slots; switch the primary call to action; publish pricing |

---

## 8. Docs tooling

### 8.1 Fumadocs or Nextra

| | **Fumadocs** | **Nextra 4** |
|---|---|---|
| App Router | Built for it | "Nextra 4 only works with the `app` router" |
| Fits inside an existing app at `/docs` | Yes; described as composable, "suits existing codebases" (Fumadocs' own comparison page) | It is "just a Next.js plugin" with a ready-made Docs Theme; "more opinionated" |
| Static export | Documented, with a static search mode (the default search uses a route handler, which static export cannot run) | Search is Pagefind, which is static by design **(from memory)** |
| Search | Built-in Orama; static index option; hosted options | Pagefind **(from memory)** |
| Extras | OpenAPI pages, TypeScript doc generation, `llms.txt`, i18n option in its CLI | Blog theme; i18n guide |
| Headless option | Yes: "Core" without the UI package | A custom theme is possible |
| Activity | About 309K weekly npm downloads against 113K for Nextra, per a third-party 2026 article **(unverified)**; one source says Nextra's last release was December 2025 **(unverified)** | — |
| Styling | Its UI package uses Tailwind CSS **(from memory; confirm the version in Step 9)** | Own theme CSS |

Sources: <https://fumadocs.dev/docs>, <https://www.fumadocs.dev/docs/comparisons>,
<https://nextra.site/docs>.

### 8.2 Recommendation: Fumadocs

- It is made to sit inside an App Router app, so `/docs` shares the
  site's header, footer, fonts and tokens.
- Its content layer (Fumadocs MDX collections with schemas) can also
  drive the blog, guides, glossary and use-case pages. One system for
  all MDX.
- Static export with a static search index is a documented path.
- The headless Core is an exit if the design pass wants full control.

Two things for the design pass and the owner to know:

1. Fumadocs UI brings Tailwind CSS. The dashboard and Staff App use a
   custom token system in `packages/ui`. Either map Rulebox tokens onto
   Fumadocs' theme variables (recommended), or use Fumadocs Core with
   custom components.
2. Fumadocs UI ships its own icons **(from memory: Lucide)**. The
   project rule is Solar icons only (Decision 16). Replace them with
   Solar icons bundled at build time. Q7 asks whether the website
   follows Decision 16.

### 8.3 Docs structure

Follow the common four-part split (tutorials, how-to guides, reference,
explanation).

```
/docs
  Start here
    What is Rulebox
    Quick start (hosted pilot)
    Requirements and Windows editions (Full / Reduced protection)
  Install and enrol
    Download and verify the installer
    Enrol a PC · Enrolment codes
    Return to normal Windows · Uninstall · Recovery
  Manage
    People and groups · Apps (winget, web, MSI/EXE, portable)
    Web app domains and permissions · File handlers
    Branding · Wi-Fi, printers and drivers
    Rollout rings and rollback · Updates · Lost-device lock · Messages
  Staff guide
    Signing in · Files · What "not allowed" means
  Security
    Threat model · Lockdown layers · Signed policies · Audit log
    Admin exit · Known limits · Report a vulnerability
  Self-hosting
    Your own Convex deployment · Environment and keys · Upgrading
  Reference
    Desired-state document · Installer exit codes · Compatibility checks
    Glossary link
  Contributing
    Repository layout · Build and test · Coding rules
  Troubleshooting
```

Rules: every page has an "Edit this page" link to the repository, a
"last updated" date from Git, and a status label for anything not in
the current release. Docs are versioned only when a second supported
version exists.

---

## 9. Analytics (privacy-friendly)

| Option | Cost | Cookies | Events and funnels | Notes |
|---|---|---|---|---|
| **Cloudflare Web Analytics** | Free | None. "does not use any client-side state, such as cookies or localStorage"; no fingerprinting | Page views, referrers, Core Web Vitals. No custom events **(from memory)** | Already on Cloudflare. One small script |
| Plausible (hosted) | Paid **(price not checked)** | None | Custom events and goals | Open source; can be self-hosted |
| PostHog (cloud free tier) | Free tier **(limits not checked)** | Can run cookieless | Full funnels, session replay | Heavier script; more data than a marketing site needs |

Source: <https://www.cloudflare.com/web-analytics/>.

**Recommendation:** Cloudflare Web Analytics at launch. No cookie banner
is needed because no cookies are set; say so on `/legal/cookies`.
Conversions are counted by the form Worker itself (it logs a count per
form per day, with no personal data), so funnels do not need a tracker.
Add Plausible later only if events are needed.

Also: Google Search Console and Bing Webmaster Tools (no scripts on the
page). No advertising pixels.

---

## 10. Forms, Turnstile and Resend

### 10.1 Forms

| Form | Path | Fields | Email goes to |
|---|---|---|---|
| Pilot request | `/pilot` → `POST /api/pilot` | Name · work email · organisation · number of PCs (ranges) · what the PCs are used for (pick list from the use cases) · Windows editions if known (optional) · message (optional) · consent tick | Owner inbox **[OWNER: address]**; auto-reply to the sender |
| Contact | `/contact` → `POST /api/contact` | Name · email · topic (general, security, press, partnership) · message | Routed by topic |
| Notify me | Footer field → `POST /api/notify` | Email only | Double opt-in confirmation email |

### 10.2 Handler steps (the small Worker)

1. Accept `POST` with JSON only; check `Origin` is the site.
2. Honeypot field must be empty; reject submissions faster than two
   seconds after page load.
3. Verify the Turnstile token on the server with Cloudflare's
   `siteverify` endpoint, including the visitor IP. **Never trust the
   widget alone.**
4. Validate and trim every field; cap lengths; strip line breaks from
   anything that goes into an email header.
5. Rate limit per IP (a Workers rate-limiting binding or a WAF rate
   rule; choose in Step 7).
6. Send through Resend's API with the key stored as a Worker secret.
   `Reply-To` is the submitter; `From` is a fixed address on the
   verified sending domain.
7. Return a small JSON result. The page shows success or a clear error
   and keeps the typed text.

### 10.3 Limits and choices

- **Turnstile free plan:** up to 20 widgets, unlimited challenges, up to
  10 hostnames per widget (<https://developers.cloudflare.com/turnstile/plans/>).
  Use one widget for production and one for previews. Load the
  Turnstile script only on pages with a form.
- **Resend free plan:** 3,000 emails a month, 100 a day, 3 domains
  (<https://resend.com/pricing>). Each pilot request costs two emails
  (owner + auto-reply), so the daily cap is about 50 requests. Enough
  for a pilot; if a launch spike is expected, turn the auto-reply off
  for that day.
- **Resend key:** PRD 12.3 already has a Resend key as an
  operator-owned platform secret for the dashboard. Use a **separate
  key and a separate sending subdomain** for the website (for example
  `mail.<domain>` for the product and `hello.<domain>` for the site), so
  a website problem cannot hurt product email reputation. (Q6)
- **Where requests are stored:** email only at launch. No database.
  If a list is needed later, use a Cloudflare D1 table or a private
  spreadsheet, **not Convex** (Section 1.4).
- **Email DNS:** SPF, DKIM and DMARC records for the sending domain, on
  Cloudflare DNS.
- **Privacy:** the form says what is collected and why, links to the
  privacy page, and collects nothing optional by default.
- **Works without JavaScript?** Turnstile needs JavaScript. Offer a
  plain email address on the page as the fallback.

---

## 11. Download page

### 11.1 What it shows

1. **The current version** and release date.
2. **One download button** for the MSI (one installer for every
   organisation, PRD 9.1), linking to the file on GitHub Releases.
3. **The SHA-256 checksum**, in text that can be copied.
4. **How to verify,** in two commands shown on the page:
   `Get-FileHash .\Rulebox-<version>.msi -Algorithm SHA256` and
   `Get-AuthenticodeSignature .\Rulebox-<version>.msi`.
5. **Signature status, stated honestly.** When signed through SignPath
   the certificate subject is SignPath Foundation's, not "Rulebox"
   (Phase 6 plan). Say so, or people will think the file is wrong.
   Until signing is live, say the build is unsigned and that Windows
   SmartScreen will warn.
6. **Requirements:** Windows version and edition notes, administrator
   rights, free disk space, WebView2 (installed by Setup; needs internet
   on Windows 10), all from PRD 14.
7. **What you need next:** an enrolment code from your dashboard. A
   line for people without one: "No dashboard yet? Request a pilot
   invite."
8. **Older versions** and release notes: link to GitHub Releases.
9. **A warning:** install on a test PC first. Rulebox changes how the
   PC starts.

### 11.2 Where the data comes from

- At **build time**, a script calls the GitHub Releases API for the
  latest stable release and reads: tag, date, the MSI asset URL and
  size, and a `SHA256SUMS` file attached to the release. The result is
  written to `content/release.json` and rendered statically.
- The release workflow (Phase 6, Step 9) must attach a `SHA256SUMS`
  asset. **Add this to the Phase 6 release pipeline if it is not there.**
- After publishing a release, the release workflow calls a Cloudflare
  deploy hook (or re-runs the website workflow) so the page updates.
- If the API call fails, the build fails loudly. It never ships a page
  with an empty or stale checksum.
- The checksum on the website and the file on GitHub come from two
  places on purpose: someone who tampers with one must also tamper with
  the other.
- The build needs a GitHub token only if the repository is private or
  rate limits bite. If the repository is private, public downloads from
  GitHub Releases will not work at all. (Q5)

### 11.3 Not on the download page

No direct file hosting on the website Worker (keep files on GitHub
Releases). No auto-download on page load. No email gate.

---

## 12. Cloudflare setup

| Item | Setup |
|---|---|
| **Zone** | The domain on Cloudflare DNS, proxied |
| **Worker** | One Worker `rulebox-website`: static assets from `apps/website/out`, script from `apps/website/worker`, `run_worker_first` only for `/api/*` |
| **Custom domains** | Apex and `www` on the Worker; `www` → apex redirect rule. `app.` and `admin.` belong to other projects |
| **Environments** | `production` (the domain) and `preview` (`*.workers.dev`, `noindex`) |
| **Deploys** | Option 1: Cloudflare Workers Builds connected to the GitHub repository, root `apps/website`, with preview URLs per branch. Option 2: a GitHub Actions workflow running `pnpm build` and `wrangler deploy`. **Recommendation: GitHub Actions**, because the same workflow runs the honesty gates, link checks and Lighthouse before deploying, and the release workflow can trigger it |
| **Secrets** | `TURNSTILE_SECRET`, `RESEND_API_KEY`, `FORM_TO_ADDRESS` as Worker secrets. `CLOUDFLARE_API_TOKEN` (scoped to this Worker) as a GitHub Actions secret. Nothing in the repository |
| **Caching** | `/_next/static/*`: `Cache-Control: public, max-age=31536000, immutable` in `_headers`. HTML: short edge cache with revalidation, purged on deploy |
| **Security headers** (`_headers`) | `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (deny camera, microphone, geolocation), `X-Frame-Options: DENY`, and a Content-Security-Policy that allows self, Cloudflare Turnstile (`challenges.cloudflare.com`) and the analytics beacon only. A static export cannot use per-request nonces, so inline scripts must be avoided or hashed. **Test the CSP in report-only mode first (Step 12)** |
| **WAF** | Cloudflare managed rules on. A rate-limiting rule on `/api/*`. Bot Fight Mode on, but confirm it does not block search engine crawlers. Free-plan rule counts were not checked today |
| **TLS** | Full (strict); always use HTTPS; HSTS after a week of clean running |
| **Email DNS** | SPF, DKIM, DMARC for the Resend sending domain |
| **Verification records** | Google Search Console and Bing through DNS TXT |
| **`security.txt`** | `/.well-known/security.txt` with the security contact and expiry date |
| **Web Analytics** | Enabled for the zone (Section 9) |

Operator console: `admin.<domain>` must never appear in page content,
the sitemap, `robots.txt`, redirects, CSP lists or the repository's
public website code. A CI check searches the built `out/` folder for the
string `admin.`.

---

## 13. Performance and accessibility

### 13.1 Performance rules

- Server Components by default. A client component needs a reason:
  mobile menu, forms, docs search, copy-to-clipboard.
- No client-side data fetching on marketing pages.
- Fonts self-hosted through `next/font/local`: Figtree variable and
  Geist Mono (Decision 19), `font-display: swap`, size-adjusted
  fallbacks, Latin subset first. **No Google Fonts, no font CDN.** This
  follows the spirit of Decision 17 and removes a third-party request.
- Icons bundled at build time (Solar, per Decision 16, if Q7 confirms).
- Animation: the design pass decides, but the technical rule is fixed.
  Follow the dashboard's rule in `CLAUDE.md`: plain CSS, `transform` and
  `opacity` only, honour `prefers-reduced-motion`. **No GSAP on the
  website.** The pure-CSS `<LogoMotion>` from `packages/ui` may be used
  as it is.
- Video: none autoplaying above the fold. Product clips are short,
  muted, lazy-loaded, with a poster image, and hosted as static files
  only if small **(each asset must be under 25 MiB)**.
- Budgets from Section 6.6 are enforced by Lighthouse CI and a bundle
  size check.

### 13.2 Accessibility (target: WCAG 2.2 level AA)

| Area | Rule |
|---|---|
| Structure | Landmarks, one H1, ordered headings, a "Skip to content" link |
| Keyboard | Everything reachable and usable by keyboard; visible focus; menus close on Escape; no focus traps |
| Contrast | Text 4.5:1, large text and UI parts 3:1 (a requirement for the design pass) |
| Motion | Honour `prefers-reduced-motion`; nothing flashes |
| Forms | Real `<label>`s, errors in text next to the field and announced, `autocomplete` attributes, no placeholder-only labels |
| Media | Alt text on every meaningful image; empty alt on decoration; captions on videos |
| Targets | Pointer targets at least 24×24 CSS pixels |
| Language | `lang` on `<html>`; plain words (helps everyone) |
| Zoom | Usable at 200% zoom and 320 px width |
| Testing | axe in CI on key pages; manual keyboard pass; one screen-reader pass (NVDA on Windows) before launch |

---

## 14. Repository layout and project rules

```
apps/website/
  app/                 routes (App Router)
    (marketing)/       home, product, features, use-cases, compare, pricing...
    docs/              Fumadocs layout and catch-all route
    blog/ guides/ glossary/ changelog/ legal/
    sitemap.ts  robots.ts  llms.txt/route.ts  not-found.tsx
  components/          page sections (built after the design pass)
  content/             MDX and data (Section 7.1)
  lib/                 pageMeta, jsonLd, content loaders, release fetcher
  public/              static files, _headers, _redirects, .well-known/
  worker/              the small /api Worker (forms)
  scripts/             image prep, release fetch, honesty gates, link check
  next.config.ts       output: 'export'
  wrangler.jsonc
  package.json         name: @rulebox/website
```

How it fits the monorepo:

- **pnpm workspace**, never npm or yarn. Versions go through the
  workspace catalogue like the other apps.
- **Root scripts to add:** `dev:website`, `build:website`,
  `test:website` (this edits the root `package.json`; a task for the
  build step, not this plan).
- **Brand:** take the logo from `packages/ui` (`<LogoMark>`,
  `geometry.ts`). Never redraw it. Favicons and site icons come from
  `pnpm gen:brand`; extend that script to write the website's icons
  instead of adding files by hand.
- **Design tokens:** reuse `packages/ui` tokens where the design pass
  says so. `packages/ui` is built for Vite apps; check that it imports
  cleanly into Next.js (CSS imports, `'use client'` boundaries) in
  Step 1.
- **Disk space:** a Next.js app adds roughly 0.5–1 GB of `node_modules`
  links and `.next` cache **(estimate)**. Add `.next/` and `out/` to
  `.gitignore`. No Rust build is involved.
- **Node:** the repo requires Node ≥ 22. Use the same in CI.
- **Tests:** unit tests for `pageMeta`, the JSON-LD helper, the content
  schema, the honesty gates and the form Worker (Turnstile and Resend
  mocked).

---

## 15. Phased build steps with verification

Each step ends with a check. "Owner" marks steps that need the owner.

### Phase 0 — Decisions (no code)

| Step | Work | Verification |
|---|---|---|
| 0.1 | Owner answers Section 17 | Answers written into this file |
| 0.2 | Owner reviews `story-and-copy.md`: positioning, hero, use-case list, pricing wording | Marked approved or edited |
| 0.3 | Domain bought and on Cloudflare; GitHub repository visibility decided | DNS resolves; repo URL known |
| 0.4 | Design pass starts from the approved content (separate work) | Design hand-off exists before Phase 2 |

### Phase 1 — Skeleton and pipeline (can run in parallel with the design pass)

| Step | Work | Verification |
|---|---|---|
| 1 | Create `apps/website` (Next.js 16, App Router, TypeScript, `output: 'export'`); one placeholder page; `wrangler.jsonc` with static assets; deploy a preview | `pnpm --filter @rulebox/website build` writes `out/`; preview URL loads; `/pricing` and `/pricing/` behave as chosen; unknown path returns the 404 page with status 404; preview sends `noindex` |
| 2 | Metadata helper, `sitemap.ts`, `robots.ts`, JSON-LD helper, OG image generation | View source shows correct tags; sitemap lists pages; **OG images build under static export** (or the fallback script is in place); Rich Results Test passes for `SoftwareApplication` |
| 3 | Content system: MDX, typed front matter, `blocks`, `numbers.ts`, `claims.ts`, `<Stat>`, `<Status>` | A page with a bad front-matter field fails the build; a `[PILOT RESULT` in a non-draft page fails the build |
| 4 | CI workflow: typecheck, lint, tests, honesty gates, link check, Lighthouse CI, deploy preview per pull request | A pull request shows all checks and a preview URL |
| 5 | Fonts (local Figtree and Geist Mono), base HTML structure, skip link, header and footer **content** without final styling | No request to any font or icon CDN in the network panel; axe passes |

### Phase 2 — Launch set, L1 (needs the design hand-off)

| Step | Work | Verification |
|---|---|---|
| 6 | Build page sections from the design; home, product, features index and five feature pages, use-case hub, pricing, open source, security, roadmap, about, legal | Each page matches its row in Section 5; one H1; unique title and description; screenshots reviewed by the owner |
| 7 | Forms Worker: `/api/pilot`, `/api/contact`, `/api/notify`; Turnstile; Resend; rate limit | Real test submission arrives by email; a request without a valid Turnstile token is rejected; 20 fast requests from one IP are limited; unit tests pass |
| 8 | Download page with the release fetcher; `/changelog` | Page shows the real latest release and checksum; `Get-FileHash` on the downloaded MSI matches the page; with no release yet, the page shows an honest "first release coming" state |
| 9 | Docs with Fumadocs: layout, static search, first set (Start here, Install and enrol, Security, Self-hosting stubs marked as drafts) | Search finds a term offline from the server (static index); docs pages meet the 160 kB budget; Solar icons in place if Q7 says so |
| 10 | Accessibility and performance pass | Lighthouse gates pass on home, a feature page, a use-case page, a docs page and `/pilot`; keyboard and NVDA pass done |
| 11 | Truth pass: every claim checked against the current release and the PRD; every number checked against its source | Signed off by the owner; "checked" dates set |
| 12 | Production: custom domain, redirects, `_headers` with CSP (report-only first, then enforced), WAF rules, analytics, Search Console and Bing, `security.txt`, email DNS | `curl -I` shows the headers; securityheaders-style scan is clean; sitemap submitted; a production form test arrives; no `admin.` string in `out/` |
| 13 | **Launch (owner's go-ahead)** | Live checks: all L1 URLs return 200; canonical URLs correct; analytics shows visits |

### Phase 3 — Use cases and comparisons, L2

| Step | Work | Verification |
|---|---|---|
| 14 | Five industry pages (retail, schools, clinics, call centres, hotels) from Story §6 | Template blocks present; "illustration" note present; limits block present |
| 15 | Remaining feature pages; pillar guide `/windows-kiosk-software` | Internal-link rules pass (no orphan; hub links) |
| 16 | `/compare/windows-kiosk-mode`; `/numbers` page | Every competitor fact has a source and date |
| 17 | Blog engine, RSS, first three posts | Feed validates; `BlogPosting` data valid |

### Phase 4 — Content library, L3

| Step | Work | Verification |
|---|---|---|
| 18 | Glossary (15 terms) and guides (8) from Story §12.4 | Each links to one feature or pillar page; no thin pages (≥ 300 words) |
| 19 | More industry pages; `/compare/intune`, `/hexnode`, `/scalefusion` after fresh research | Sources dated within 30 days of publishing |
| 20 | `/brand`, `/legal/sub-processors`, full docs set | — |

### Phase 5 — After the pilot, L4

| Step | Work | Verification |
|---|---|---|
| 21 | Replace **[PILOT RESULT]** slots with real, approved results; add the first real customer story | Written consent on file |
| 22 | Pricing with real plans; switch `cta.pilot` to "Start free" | One-line change, as designed |
| 23 | Translations, if Q9 says so | `hreflang` valid |
| 24 | Review hosting choice (stay static, or move to option B) | Decision recorded |

---

## 16. Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| R1 | The site claims a feature that is not in the downloadable release | Lost trust; the worst outcome for a security product | `claims.ts`, status labels, the truth pass (Step 11), release-time review |
| R2 | A placeholder or invented number ships | Same | Build-failing honesty gates |
| R3 | A static export limit blocks something later (personalisation, live data) | Rework | The portability rule (3.3); option B is a config change |
| R4 | OG image generation or another metadata file does not build under static export | Missing social cards | Checked in Step 2; fallback build script |
| R5 | Cloudflare's Next.js guidance changes again (vinext leaves beta, OpenNext is dropped) | Only matters for option B or C | Option A is not affected |
| R6 | Fumadocs brings Tailwind and its own icons, clashing with the Rulebox token system and Decision 16 | Design friction | Map tokens to its theme variables, replace icons, or use the headless Core |
| R7 | Form spam or abuse burns the Resend quota (100 a day) | Real requests bounce | Turnstile checked on the server, honeypot, rate limit, WAF rule, a daily cap in the Worker with a clear "email us instead" message |
| R8 | The download checksum on the page goes stale | People cannot verify; trust lost | Build fails without release data; the release workflow triggers a rebuild |
| R9 | The installer is unsigned at launch, or signed as "SignPath Foundation" | SmartScreen warnings; confused admins | Say it plainly on the download page |
| R10 | Competitor facts go out of date or are wrong | Legal and trust risk | Source and date on every fact; quarterly re-check; fair tone |
| R11 | New domain, no authority: search traffic is slow for months | Fewer pilot requests | Focus on narrow, honest pages (open-source kiosk, Windows Home, 4 GB); share the engineering posts where developers read |
| R12 | `packages/ui` does not import cleanly into Next.js | Duplicate brand code | Test in Step 1; if needed, export a small framework-neutral brand entry |
| R13 | The operator console address leaks through the site | Attack surface | CI string check on `out/`; never in CSP or redirects |
| R14 | Free-plan limits change | Cost | Static assets are the cheapest shape; the Worker handles only form posts |
| R15 | Statistics were read from summaries, not primary reports | A wrong number in public | Listed in Story §14; primary check is part of Step 11 |
| R16 | Disk space on the dev machine | Builds fail | `.next` and `out` are small; clean with `pnpm --filter @rulebox/website exec rimraf .next out` when needed |

---

## 17. Open questions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| **Q1** | How should Next.js run on Cloudflare? | (a) Static export + one small Worker for forms. (b) Full Next.js on Workers through OpenNext (may need Workers Paid; builds in CI, not on Windows). (c) vinext (Cloudflare's new default; beta; not real Next.js) | **(a).** Free, fastest, builds on Windows, no adapter risk. Move to (b) only when a page needs a server |
| **Q2** | What is the domain, and apex or `www`? | Owner supplies | Apex as canonical, `www` redirects |
| **Q3** | What may the pricing page say during the pilot? | (a) "Free and open source; hosted pilot is free; plans to be announced". (b) Also publish the planned free-plan limits (2 devices, 25 employees, 20 apps...). (c) Publish paid prices now | **(a)** now, **(b)** once the limits are final. Do not publish prices before the pilot's I/O numbers exist |
| **Q4** | Is the download public during the invite-only pilot? | (a) Public page; the installer needs an enrolment code anyway. (b) Hidden until the pilot ends | **(a).** It helps evaluators and search, and the installer is useless without a code. Show the "test PC first" warning |
| **Q5** | Is the GitHub repository public at launch, and under which account or organisation? | (a) Public under an organisation named for the project. (b) Public under the personal account. (c) Private for now | **(a).** "View the source" is a core trust message; the open-source page cannot launch with (c) |
| **Q6** | Email: which inbox receives pilot requests, and a separate Resend key and sending subdomain for the website? | Owner supplies; separate or shared | Separate key and subdomain |
| **Q7** | Does the website follow Decision 16 (Solar icons only) and Decision 19 (Figtree and Geist Mono)? | (a) Yes to both. (b) The design pass may choose | **(a)**, for one brand |
| **Q8** | Allow AI crawlers and publish `/llms.txt`? | (a) Allow. (b) Block | **(a)** |
| **Q9** | Languages after English? | Owner names the markets | English only at launch; build locale-ready |
| **Q10** | Which use cases launch first? | The Tier 1 list in Story §6.1, or another order | Hub + retail, schools, clinics, call centres, hotels |
| **Q11** | Primary hero line | "Only what you allow." (the existing tagline) or the alternates in Story §13.1 | The tagline, with a category sub-headline |
| **Q12** | May the site say which Windows editions and builds are supported? | Needs the minimum supported build and the Home-edition result from VM tests | Publish only tested combinations |
| **Q13** | Who is "we"? | A named founder and story on `/about`, or project-only | A real name builds trust for a security tool |
| **Q14** | Legal pages: who writes the privacy policy and terms? | Owner or a lawyer | A lawyer reviews before the pilot takes outside organisations |
| **Q15** | Spelling | British or American | Pick one; the checks enforce it |

Also for the owner's attention (not questions):

- **PRD mismatch found:** Microsoft's Windows 10 end-of-support page, as
  read today, gives consumer ESU "until October 12, 2027". PRD 13.6
  row 4 says 13 October 2026 with the extension unconfirmed. Please
  confirm and update the PRD.
- **Phase 6 dependency:** the release pipeline should attach a
  `SHA256SUMS` file to each GitHub release and trigger a website rebuild.
- **FAQ rich results are gone from Google** (F5). The FAQ content is
  still worth writing; just do not expect rich results from it.

---

## 18. Sources

Read on 2026-11-21. Quotes in this file are from these pages.

**Hosting and framework**
- Cloudflare, Next.js on Workers (vinext recommendation): <https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/>
- Cloudflare Workers limits (100,000 requests a day, 10 ms CPU, static asset limits): <https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare static assets billing ("free and unlimited"): <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
- OpenNext for Cloudflare (supported versions and features, 3 MiB / 10 MiB, Windows note): <https://opennext.js.org/cloudflare> · setup: <https://opennext.js.org/cloudflare/get-started>
- vinext announcement: <https://blog.cloudflare.com/vinext-nextjs-on-vite/> (title seen in search results; body not read)
- Next.js static exports (supported and unsupported features): <https://nextjs.org/docs/app/guides/static-exports>
- Next.js metadata and OG images: <https://nextjs.org/docs/app/getting-started/metadata-and-og-images>

**Docs tooling**
- Fumadocs: <https://fumadocs.dev/docs> · comparisons: <https://www.fumadocs.dev/docs/comparisons> · static build: <https://www.fumadocs.dev/docs/deploying/static> (seen in search results; not opened)
- Nextra: <https://nextra.site/docs>

**SEO**
- Google, FAQ structured data page (feature no longer shown): <https://developers.google.com/search/docs/appearance/structured-data/faqpage>

**Services**
- Cloudflare Turnstile plans: <https://developers.cloudflare.com/turnstile/plans/>
- Resend pricing: <https://resend.com/pricing>
- Cloudflare Web Analytics: <https://www.cloudflare.com/web-analytics/>

**Repository**
- `CLAUDE.md` (project rules: pnpm, icons, fonts, animation, I/O budget)
- `docs/prd.md` (Sections 9.1, 12.3, 14, 16, 21, 23.8)
- `docs/plans/phase-6-installer-pilot.md` (release pipeline, SignPath, MSI size budget)
- `docs/plans/post-phase-5-architecture-and-io.md` (free-plan limits, hosted-service plan)

**Not verified (flagged in the text)**
- Workers Paid price; Cloudflare WAF free-plan rule counts.
- Whether `opengraph-image.tsx` builds under `output: 'export'` (Step 2 checks it).
- How Cloudflare static assets handle trailing slashes and 404 status with this setup (Step 1 checks it).
- Fumadocs UI details: Tailwind version, default icon set, exact static-search setup.
- Nextra's search engine and release activity; npm download figures.
- Cloudflare Web Analytics custom-event support; Plausible and PostHog prices and limits.
- Core Web Vitals thresholds were written from memory of web.dev.
- The disk-space estimate for the Next.js app.
