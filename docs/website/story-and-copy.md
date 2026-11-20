# Rulebox website: research, story and copy

**Status:** Draft 1 · **Written:** 2026-11-21 · **Owner review:** pending
**Companion file:** `docs/plans/website-nextjs.md` (the build plan)
**Scope:** content, story, structure and SEO. No colours, visual style or
layouts here. A separate design pass decides those.

## How to read this file

| Part | What it holds |
|---|---|
| 1 | Honesty rules and the markers used in this file |
| 2 | Research: what real product websites do, with URLs |
| 3 | The patterns we take from them, and the ones we refuse |
| 4 | Positioning and messaging |
| 5 | The Rulebox story (the main narrative) |
| 6 | Use-case and industry stories |
| 7 | The numbers block (true product numbers, cited industry numbers, placeholders) |
| 8 | Feature copy, with a truth table against the PRD |
| 9 | Objections and FAQ |
| 10 | Open-source and security trust copy |
| 11 | Comparison copy (fair, sourced) |
| 12 | SEO keyword map and per-page metadata |
| 13 | Reusable copy blocks (ids for components) |
| 14 | Sources |

---

## 1. Honesty rules

These rules apply to every page, forever.

1. **No invented proof.** No customer counts, logos, testimonials, star
   ratings, case studies or results until they are real and the customer
   has agreed in writing.
2. **Three kinds of numbers only:**
   - **[PRD]** a true product number from `docs/prd.md` or a phase plan.
   - **[MEASURED]** a number we measured, with the date and conditions.
   - **[CITED]** an industry number with a source URL.
3. **Placeholders are loud.** Anything that must come from real customers
   is written as **[PILOT RESULT]**. Anything the owner must supply is
   **[OWNER]**. A page with a placeholder left in it must not ship. The
   build fails on these strings (see the plan, Section 7).
4. **Roadmap is labelled.** Features that are not in v1 carry a "Coming"
   or "Planned" label. Android is "Coming in v2".
5. **Limits are stated.** Each feature page has a short "What it does not
   do" part. This is a trust pattern, not a weakness (Section 3, pattern 9).
6. **Claims are re-checked at release.** Rulebox is in pilot. Section 8.1
   lists every claim with its PRD section. Before the site goes live, each
   row is checked against the release that people can download.

Markers used below: **(unverified)** means I could not confirm it from a
first-hand source today. **(from memory)** means prior knowledge that I
did not re-check today.

---

## 2. Research: what real product sites do

All pages were read on 2026-11-21. Quotes are exact where shown in
quotation marks. Pages were read through a text extractor, so visual
details (buttons, images) can be missing.

### 2.1 Kiosk and device-management vendors (our category)

| Site | Hero message | Calls to action | Proof they show | What stands out |
|---|---|---|---|---|
| **Scalefusion, Windows kiosk page** <https://scalefusion.com/windows-kiosk-mode> | Title: "Windows Kiosk Mode for Business, Schools & Public Use". H1: "Setup Windows kiosk mode for seamless and secure user access." | "Start free trial", "Schedule a demo", repeated about eight times | "Trusted by 12000+ businesses globally", "ISO/IEC 27001:2022 Certified and SOC-2 Type-2 Compliant" | The page is a textbook SEO landing page. Order: "What is Windows kiosk mode?" → types (single-app, multi-app) → features → industries ("Ready for every industry", 12 listed) → FAQ (5 questions). It answers the search query first and sells second |
| **Hexnode** <https://www.hexnode.com/> | "Unified Endpoint Management made for tomorrow" | "Try For Free", "Request Demo", "14 Day Free Trial ... No credit card" | Analyst badges (Gartner, IDC, Forrester), a logo grid, 11 named testimonials, SOC / GDPR badges | Industries live in the footer (Education, Government, Banking, Retail, Logistics, Healthcare, Hospitality). A large "Explained" library works as a glossary: <https://www.hexnode.com/blogs/explained/> with titles like "What is ...?", "X vs Y: Which one should you choose" |
| **Esper** <https://www.esper.io/> | Eyebrow: "POS, KIOSKS, PAYMENT TERMINALS, CLINICAL DEVICES". Headline: "Device Management Infrastructure for the Operating Edge". Sub: "When your business depends on hardware working, Esper is the layer under the hood." | "Book a Demo" everywhere | A stat row tied to customers: "85%" less provisioning time, "4,000" support tickets prevented, "70,000" devices configured with one command. Section title: "Their words. Not ours." | Navigation splits Solutions three ways: by operating system, by industry (12) and by form factor (Kiosk, POS, Signage...). The hero image is a scene (a diner with POS and kiosks), not a dashboard screenshot. Release notes sit on the home page |
| **42Gears SureLock** <https://www.42gears.com/products/surelock/> | H1: "Kiosk Software". Sub: "Kiosk software solution converts off-the-shelf devices into dedicated purposes devices" | "Try For Free", "Watch Video", "Download Brochure" | "ISO/IEC 27001:2022 Certified"; price anchor: legacy kiosk machines cost "around $1000 to $4000" | The core argument is "use the hardware you already have". FAQ block of 6 questions. Industries: field services, education, retail, healthcare |
| **Jamf** <https://www.jamf.com/> | "Govern AI on Mac. Manage all of Apple." | "Start Trial", "Learn More" | Rank-based stats instead of counts: "7 of the Top 10" technology companies, "15 of the Top 15" largest U.S. banks | Industries in the top navigation (Business, Education, Healthcare). Pricing is split by audience (Business, Education) |
| **Iru (was Kandji)** <https://www.iru.com/kandji-mdm/> | "Kandji is now Iru" | "Book a demo", "Request a quote" | "Trusted by teams at 6,000+ companies", logo strip, one named quote | A "Migration made easy" section and an FAQ block on a product page |
| **Fleet** <https://fleetdm.com/> | "Deliver entire IT projects in minutes, not weeks" | "Get a demo" (work-email field in the hero), "Try it yourself" | Named quotes from engineers, "Customers cut maintenance effort by 50–80%", ISO 27001 / SOC 2 badges | A comparison table against Intune, Jamf and others sits **second on the home page**. A "Nothing you don't" section lists what the product leaves out. Open source is quiet on the home page: a footer link "Why open source?" and a public handbook. Pricing <https://fleetdm.com/pricing>: "Free" at "$0 / host / month" ("Basic features, no support"), "Premium" at "$7.00 / host / month" |
| **Microsoft, Assigned Access docs** <https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview> | (documentation) | — | — | This is the built-in alternative buyers find first. It supports "Pro, Enterprise / Enterprise LTSC, Education, IoT Enterprise". Home is not in the list. The multi-app "restricted user experience" is set up with an XML file through Intune, a provisioning package or PowerShell run as SYSTEM: <https://learn.microsoft.com/en-us/windows/configuration/assigned-access/quickstart-restricted-user-experience> |

Pricing in our category (read 2026-11-21):

| Vendor | Public price | Minimum | Source |
|---|---|---|---|
| Hexnode | "Pro" $2.2, "Enterprise" $3.2, "Ultimate" $4.7 per device per month; "Ultra" on request | "Start with 15 devices" | <https://www.hexnode.com/mobile-device-management/pricing/> |
| Scalefusion | $2, $3.5, $5, $6 per device per month, "Billed Annually Only" | "Minimum of 10 total devices required" | <https://scalefusion.com/pricing> |
| Fleet | $0 (free) and $7.00 per host per month | Managed cloud "only available for customers with 700+ hosts" | <https://fleetdm.com/pricing> |
| Microsoft Intune Plan 1 | $8.00 per user per month, annual commitment (unverified: from search results of Microsoft's pricing page, prices vary by region) | Needs Windows Pro or higher to enrol | <https://www.microsoft.com/en-us/security/business/microsoft-intune-pricing> |

### 2.2 Developer-loved and open-source product sites (our tone and trust model)

| Site | Hero message | What stands out |
|---|---|---|
| **Tailscale** <https://tailscale.com/> | "Maybe don't put it on the public internet." Sub explains the category in one line | The headline is a point of view, not a feature. Stat blocks are each tied to a named customer and a "Read case study" link ("90%" fewer support requests, Instacart). "50,000 businesses choose Tailscale". Top navigation: Docs, Download, Blog, Pricing, Customers, "Compare Tailscale", Changelog. A "Bring Tailscale to work" page ("Make the case") helps one fan sell it inside their company |
| **Tailscale comparison page** <https://tailscale.com/compare/wireguard> | "WireGuard® vs. Tailscale: Which is Better for You?" | The fairest comparison format found. It praises the alternative ("we think very highly of it"), says "Using WireGuard directly is a very reasonable choice", compares on six named dimensions and ends with "The bottom line": who should pick which |
| **Linear** <https://linear.app/> | "The product development system for teams and agents" | Very little text. Sections follow the customer's workflow in order (intake → plan → build → ship). The **changelog is on the home page**, with dates. "Linear powers over 50,000 product teams." |
| **Sentry** <https://sentry.io/welcome/> | "Code breaks, fix it faster". Sub: "Application monitoring software considered "not bad" by millions of developers." | A human, slightly dry voice. "Get started in minutes" with real steps. Security and compliance get their own section near the end |
| **Supabase** <https://supabase.com/> | "Build in a weekend. Scale to millions." | Two short sentences: a small promise and a big one. "all core tools are open source and self-hostable" is stated as a plain fact |
| **PostHog** <https://posthog.com/> and <https://posthog.com/pricing> | Page title: "PostHog – Your product's context layer". Pricing title: "PostHog pricing – Start free, scale when you need" | Only the titles and "Get started – free" loaded today. PostHog is known for public pricing, a public handbook and blunt comparison pages (from memory; the handbook comparison page returned 404 today, so no quote is used) |

Not read today, so no claims are made about them: Vercel, Cloudflare's
own marketing pages, Microsoft Intune's marketing page.

---

## 3. Patterns we take, and patterns we refuse

### 3.1 Fifteen patterns found

| # | Pattern | Seen at | What Rulebox does with it |
|---|---|---|---|
| 1 | **Hero = outcome or point of view**, then one plain sentence that names the category | Tailscale, Supabase, Sentry, Fleet | Headline is the promise ("Only what you allow"). The sub-headline names the category in words people search for: "kiosk software for Windows", "shared staff PCs" |
| 2 | **Two calls to action:** one to commit, one to learn | All | Primary: "Request a pilot invite". Secondary: "See how it works" or "Read the docs". No "free trial" wording while sign-up is invite-only |
| 3 | **Show a scene, not only a screenshot** | Esper | Each use-case page opens with a real moment in a real place (Section 6), then the product |
| 4 | **Sections follow the user's day**, not the feature list | Linear | Home page order: the problem → enrol a PC → staff sign in → admin changes something → it goes wrong and recovers |
| 5 | **Three-way navigation into the same product:** by industry, by use case, by feature | Esper, Hexnode, Jamf, Scalefusion | "Use cases" menu (by place and by job) plus "Product" menu (by feature) |
| 6 | **The SEO landing page shape:** "What is X?" → types → how it works → features → industries → FAQ | Scalefusion, 42Gears | Our "Windows kiosk software" page and glossary pages use this shape |
| 7 | **Numbers tied to a source** | Tailscale, Esper, Jamf | Our numbers are product facts and cited statistics until pilots give results (Section 7) |
| 8 | **Fair comparison pages** with "who should pick which" | Tailscale, Fleet | Section 11. We say when Windows' own kiosk mode or an MDM is the better choice |
| 9 | **"What we leave out"** as a selling point | Fleet ("Nothing you don't") | "What Rulebox does not do" blocks, and a public list of limits |
| 10 | **Open source as a fact, plus one deep page** | Supabase, Fleet ("Why open source?") | One line on the home page, a full `/open-source` page |
| 11 | **Changelog as proof of life** | Linear, Esper | Latest three releases on the home page, pulled from the repo |
| 12 | **Public, simple pricing with a free tier** | Fleet, Scalefusion, PostHog | A pricing page that is honest about the pilot (Section 9.3) |
| 13 | **Trust section near the end:** security, compliance, audits | Sentry, Esper, Hexnode | `/security` page. We have no certificates, so we show the design, the tests and the source code instead |
| 14 | **Glossary and "X vs Y" library** for search traffic | Hexnode "Explained" | `/glossary` with short, honest explainers (Section 12.4) |
| 15 | **"Make the case" kit** for the person who must convince a boss | Tailscale | A one-page "Why Rulebox" brief the IT person can forward (Phase D) |

### 3.2 Patterns we refuse

| Pattern | Why not |
|---|---|
| Logo walls and "Trusted by N businesses" | We have none yet. A fake one ends trust for good |
| Compliance badges (SOC 2, ISO 27001) | We hold none. We describe controls and link the code |
| Analyst badges | Not applicable |
| "Book a demo" as the only way in | Our buyer is often a shop owner or a lone IT person. Docs and a download must be reachable without a sales call |
| Hostile comparison tables with a column of red crosses | They read as dishonest. We use the Tailscale format |
| Eight repeated "Start free trial" buttons | One primary action per screen is enough |

---

## 4. Positioning and messaging

### 4.1 Who we speak to

| Reader | Who they are | What they want to know first |
|---|---|---|
| **The owner-operator** | Runs a shop, clinic, school or small office. No IT team | "Will this stop staff from messing up the PCs? Can I set it up myself?" |
| **The lone IT person** | Looks after 5 to 200 PCs across branches | "Does it really hold? What happens offline? Can I undo it?" |
| **The technical evaluator** | Reads source code before trusting an agent that runs as SYSTEM | "How is it built? What is signed? Where is the threat model?" |
| **The contributor** | Developer who found the repo | "How do I run it? Where can I help?" |

### 4.2 Positioning statement

> For organisations that share Windows PCs among staff, **Rulebox** is an
> open-source kiosk OS that turns any PC into a locked, branded
> workstation where each person signs in and sees only the apps, websites
> and files they are allowed. Unlike Windows' built-in kiosk mode, it
> needs no XML and gives staff a friendly desktop. Unlike a full MDM
> suite, it does one job, runs well on 4 GB laptops and its code is open.

### 4.3 One-liners (pick per context)

| Length | Text |
|---|---|
| Tagline [PRD 25.5] | **Only what you allow.** |
| 8 words | The staff PC that only does its job. |
| 15 words | Turn any Windows PC into a locked, branded workstation. Manage every one from the web. |
| 25 words | Rulebox turns ordinary Windows PCs into locked staff workstations. People sign in and see only their approved apps, websites and files. You manage everything from a web dashboard. |
| 50 words | Rulebox is an open-source kiosk OS for Windows. Install it on the PCs you already own. Staff sign in to a clean, branded desktop with only the apps, websites and files you approve. Change the rules from a web dashboard and every PC follows, even after being offline. Return to normal Windows at any time. |

### 4.4 Five message pillars

| Pillar | Claim | Proof we can show today |
|---|---|---|
| **1. Locked, for real** | Staff cannot reach Windows settings, a free browser, installers or other people's files | Layered lockdown [PRD 12.2]; a 74-row escape checklist run against releases [Phase 5 plan]; an agent that restarts the desktop if it crashes [PRD 23.7] |
| **2. Friendly, not a cage** | It looks and works like a simple Windows desktop: taskbar, Start menu, real windows. No training | [PRD 4]; screenshots and a short video (design pass) |
| **3. Managed from anywhere** | Add an app in the dashboard and every PC in the group gets it. Offline PCs catch up on their own | Desired-state model [PRD 10]; rollout rings and one-click rollback [PRD 24.3] |
| **4. Built for the PCs you have** | Runs on 4 GB RAM laptops. Works when the internet is down | Lite mode [PRD 22.5]; measured memory (Section 7.1); offline sign-in and cached rules [PRD 5.2, 9.4] |
| **5. Open and reversible** | MIT licence. Read the code, host it yourself. Turn kiosk mode off and the PC is normal Windows again | [PRD 15, 9.5, 21 Decision 9] |

### 4.5 Voice

- Plain words. Short sentences. Say "PC", not "endpoint". Say "staff",
  not "end users".
- Specific over grand. "Blocks Task Manager, Run and the Windows key
  shortcuts" beats "enterprise-grade security".
- Calm. No exclamation marks. No "revolutionary", "seamless",
  "next-generation", "military-grade".
- Honest about limits. "Not yet" is a full sentence.
- British or American spelling: **[OWNER]** pick one for the whole site.
  This file uses British in prose; copy blocks are spelling-neutral where
  possible.

### 4.6 Words to use and avoid

| Use | Avoid |
|---|---|
| kiosk OS, locked workstation, shared PC, staff PC | endpoint, digital workspace, solution |
| approve, allow, block | empower, enable, leverage |
| dashboard | single pane of glass |
| return to normal Windows | decommission, unenrol (except in docs) |
| open source (MIT) | "community edition" (there is one edition) |

---

## 5. The Rulebox story

This is the main narrative. The home page tells it in six short beats.
The `/product` page tells it in full.

### Beat 1. The PC everyone shares, and nobody owns

Every workplace has one. The PC at the front desk. The one at the till.
The row of them in the computer lab.

It was set up for one job. Then real life happened. Someone installed a
game. Someone saved their passwords in the browser. Someone clicked a
link in an email. Now it is slow, it shows the last person's inbox, and
nobody knows what is on it.

It is not bad people. It is an open PC. Most security incidents involve
a human action somewhere along the way: about 60% of breaches in
Verizon's 2025 report **[CITED, Section 7.2]**.

### Beat 2. The usual fixes do not fit

- **Stickers and rules** ("Do not install anything") do not hold.
- **Windows' own kiosk mode** is real, but it needs Windows Pro or
  higher and an XML file, and the multi-app mode is built for IT
  departments **[CITED]**.
- **Big device-management suites** do a hundred things. They are priced
  per device with minimum orders, and they still leave you to design the
  locked desktop yourself.
- **Buying kiosk hardware** costs real money. One vendor puts legacy
  kiosk machines at about $1,000 to $4,000 each **[CITED: vendor claim]**.

A shop with six PCs does not have an IT department. It has a person who
is "good with computers".

### Beat 3. One idea: only what you allow

Rulebox flips the PC. Nothing is available unless you approve it.

You install one small program on a PC you already own. You type a code
from your dashboard. The PC restarts as a Rulebox workstation: your name,
your logo, your apps.

### Beat 4. A day on a Rulebox PC

**08:55.** Sara opens the laptop at the front desk. The sign-in screen
shows the company name and a clock. She types her own username and
password.

**08:56.** Her desktop appears. Six tiles: the booking site, the
accounts app, Zoom, her files. A taskbar at the bottom. It looks like
Windows, only quieter. There is nothing to get wrong.

**11:20.** A PDF arrives through the booking site. She double-clicks it.
It opens in Rulebox's own viewer. No "choose an app" question. No way to
run a file that should not be run.

**13:00.** The internet drops for twenty minutes. Nothing changes on her
screen. The rules are stored on the PC.

**17:05.** Sara logs out. Her apps close. Her web logins are hers alone.
Ali signs in for the evening shift and sees his own apps, his own files.

*(This scene is an illustration of the product, not a customer story.)*

### Beat 5. Meanwhile, at the dashboard

The administrator never touches the laptop again.

- **Add an app:** pick Zoom for the "Front desk" group. Every PC in the
  group installs it quietly and reports back.
- **Roll out with care:** send a change to one test PC first, then a few,
  then everyone. If something breaks, go back one version with one click.
- **Lose a laptop:** lock it from the dashboard. It shows "This laptop
  belongs to ..." and stays locked, even offline.
- **Tell everyone something:** send a banner to every screen.
  "Maintenance at 5 pm. Please save your work."

Every change is versioned, signed and written to an audit log.

### Beat 6. Yours to keep, yours to undo

Rulebox is open source under the MIT licence. Read the code. Host the
backend yourself, or let us host it.

And it is never a trap. Turn kiosk mode off in the dashboard and the PC
is normal Windows again. Rulebox restores the settings it changed.

**Closing line:** *Your apps. Your rules. Only what you allow.*

---

## 6. Use-case and industry stories

### 6.1 How the list was chosen

Rulebox v1 is a **multi-app staff desktop with per-person sign-in** on
**Windows PCs**. Use cases were scored on three questions:

1. Is the PC **shared by staff** (strong fit) or used by the anonymous
   public (weaker fit)?
2. Does the job need **a few apps and websites** (strong fit) or one
   full-screen app with no desktop (weak fit: Windows' single-app kiosk
   already does this)?
3. Is the organisation **short on IT staff and budget** (strong fit)?

| Tier | Use case | Fit | Notes |
|---|---|---|---|
| 1 | Shared staff PCs in small and mid-size businesses | Strongest | The core story. The parent page for all others |
| 1 | Retail stores and POS counters | Strong | Windows POS and back-office PCs, many branches |
| 1 | Schools, computer labs and exam rooms | Strong | Old 4 GB PCs, no budget, many users per PC |
| 1 | Clinics and pharmacies | Strong | Shared front-desk PCs with patient data on screen |
| 1 | Call centres and BPO floors | Strong | Hot desks, shifts, one CRM and a softphone |
| 1 | Hotels and front desks | Strong | Shift handover on one PC, guest data |
| 2 | Warehouses and factory floors | Good | Shared stations for a web ERP or WMS |
| 2 | NGOs, community centres and donated PCs | Good | Old hardware, volunteers, open source matters |
| 2 | Libraries and public-access PCs | Good, with care | Works with a shared "visitor" sign-in; be honest about limits |
| 2 | Government and service counters | Good | Counter clerks, audit needs |
| 3 | Restaurants (back office and ordering stations) | Medium | Many restaurant POS systems are tablets; Android is v2 |
| 3 | Events: registration and check-in desks | Medium | Short-lived, rented laptops; "return to normal Windows" is the hook |
| 3 | Training centres and internet cafés | Medium | Close to schools |

**Not a target (say so on the site):** unattended single-app screens
such as digital signage, ticket machines and self-checkout. Windows'
built-in single-app kiosk is made for that. Rulebox is for people who
sign in and work.

Every story below uses the same four parts: **the problem, the moment,
how Rulebox solves it, the outcome.** Outcomes are stated as what the
product does. Measured results are placeholders until pilots finish.

Every "moment" is an illustration, not a customer story. Each page must
carry that line until a real story replaces it.

---

### 6.2 Shared staff PCs (parent use case)

**URL:** `/use-cases/shared-staff-pcs`
**Primary keyword:** shared computer software for employees ·
**Also:** lock down shared PC, multi-user kiosk Windows, restrict
employee computer access
**Intent:** problem-aware; comparing ways to lock a PC

| Field | Copy |
|---|---|
| Title tag | Lock Down Shared Staff PCs on Windows \| Rulebox |
| Meta description | One PC, many people. Rulebox gives each staff member their own sign-in, apps and files on a locked Windows desktop you manage from the web. |
| H1 | One PC. Many people. No mess. |
| Sub-headline | Rulebox turns a shared Windows PC into a locked workstation where each person signs in and sees only what they need. |

**The problem.** A shared PC collects everything. Saved passwords,
personal downloads, half-installed toolbars, the last person's email. No
one is responsible for it, so it gets slower and less safe every month.

**The moment.** Monday, 9 am. The accounts PC shows a browser full of
someone's personal tabs. The accounting app has an update prompt that
needs an admin password nobody has. The desktop holds forty files and no
one knows whose they are.

**How Rulebox solves it.**
- Each person signs in with their own details, on any Rulebox PC their
  group allows [PRD 5].
- They see only the apps assigned to them or their group [PRD 6.3].
- Each person gets their own folder and their own web logins. Logging
  out closes their apps and clears their session [PRD 5.3].
- Staff have no admin rights. Apps and updates are installed by Rulebox,
  silently [PRD 3.2].

**The outcome.** The PC is the same on Friday as it was on Monday.
Handover between people takes one log-out.
**[PILOT RESULT: support requests per PC per month, before and after]**

**H2s:** Why shared PCs go wrong · What staff see · What you control ·
Works on the PCs you have · What it does not do · FAQ

**FAQ (page-level):**
- *Can two people use the same PC with different apps?* Yes. Apps are
  assigned per group and per person.
- *Do staff need a Microsoft account?* No. They sign in to Rulebox with
  the details you give them in the dashboard.
- *Can someone sign in when the internet is down?* Yes, if they have
  signed in on that PC before. You set how long offline sign-in stays
  valid [PRD 5.2].
- *Do files follow a person from PC to PC?* Not in v1. Files stay on the
  laptop where they were saved [PRD 8].

**Internal links:** → all industry pages; → `/features/employee-sign-in`;
→ `/features/lockdown`; → `/compare/windows-kiosk-mode`.

---

### 6.3 Retail stores and POS counters

**URL:** `/use-cases/retail-pos`
**Primary keyword:** POS lockdown software Windows · **Also:** lock down
POS computer, retail kiosk software Windows, restrict cashier PC
**Intent:** solution-aware; often a store owner or retail IT lead

| Field | Copy |
|---|---|
| Title tag | POS and Store PC Lockdown for Windows \| Rulebox |
| Meta description | Keep till and back-office PCs on the job. Rulebox locks Windows PCs to your POS, web portals and approved apps, managed across every branch. |
| H1 | The till PC should only be a till. |
| Sub-headline | Lock store PCs to your POS and the few tools staff need. Manage every branch from one dashboard. |

**The problem.** The till PC handles money and customer data. It also
has a browser, a USB port and a bored cashier on a slow afternoon. One
bad download can stop sales for a day.

**The moment.** Saturday, the busiest hour. The POS freezes because
something in the background is using all the memory. Nobody at the store
can fix it. The owner is across town.

**How Rulebox solves it.**
- Only the POS app and the tools you approve can run. Task Manager, the
  Run box, Command Prompt and Windows shortcuts are off for staff
  [PRD 12.2].
- USB storage can be blocked by policy [PRD 12.2, optional].
- Web portals open in their own windows, limited to the domains you
  list [PRD 6.2].
- Receipt and label printers are pushed from the dashboard, with their
  drivers [PRD 24.2].
- New branch? Install, type the enrolment code, done. The PC pulls its
  apps and rules by itself [PRD 9.1].
- Windows background load is trimmed on kiosk PCs, so a 4 GB machine
  has more room for the POS [PRD 22.3].

**The outcome.** Every till in every branch runs the same approved set.
A change is tested on one PC before it reaches the rest.
**[PILOT RESULT: unplanned till downtime, before and after]**

**What it does not do.** Rulebox is not a POS and not a payment
terminal. It does not make a store PCI DSS compliant by itself. It
reduces what can run on the PC.

**FAQ:**
- *Will my POS software work?* If it installs silently as an MSI or EXE,
  or runs as a web app, yes. Test it on one PC first [PRD 6].
- *Does Rulebox update my POS?* You choose per app: keep a pinned
  version, let the vendor's updater run, or let Rulebox manage versions
  with staged rollout [PRD 23.2].
- *What if the store loses internet?* The PC keeps working with its
  stored rules. Changes arrive when it reconnects [PRD 9.4].

**Internal links:** → `/features/apps`; → `/features/updates-and-rollouts`;
→ `/use-cases/restaurants`; → `/glossary/pos-lockdown`.

---

### 6.4 Schools, computer labs and exam rooms

**URL:** `/use-cases/schools-and-computer-labs`
**Primary keyword:** computer lab lockdown software · **Also:** school
PC kiosk software, lock down exam computers, restrict student computer
Windows
**Intent:** problem-aware; school IT coordinator or teacher in charge

| Field | Copy |
|---|---|
| Title tag | Computer Lab and Exam PC Lockdown for Schools \| Rulebox |
| Meta description | Lock lab PCs to lesson apps and approved websites. Rulebox is open source, runs on 4 GB PCs and puts every lab under one web dashboard. |
| H1 | A lab that is ready when the bell rings. |
| Sub-headline | Lock school PCs to the lesson, the exam site or the library catalogue. Reset between classes by logging out. |

**The problem.** Thirty PCs, six classes a day, one part-time IT
teacher. The PCs are old. Students are curious. Schools are also a
target: in one study of more than 5,000 K-12 organisations, 82% reported
cyber threat impacts over 18 months **[CITED, Section 7.2]**.

**The moment.** Exam morning. Four PCs show yesterday's class still
signed in to a website. Two have a game installed. One will not start
the exam site because someone changed the proxy.

**How Rulebox solves it.**
- Each group sees its own apps. "Year 9" gets the typing tutor.
  "Exam room" gets one website [PRD 6.3].
- Web apps are limited to listed domains. Everything else shows a clear
  "not allowed" page [PRD 6.2].
- Per-site permissions: camera, microphone, clipboard and screen sharing
  are blocked unless you allow them [PRD 24.1].
- Log-out closes apps and clears the session for the next class
  [PRD 5.3].
- Lite mode is chosen automatically on PCs with 4 GB of RAM or less
  [PRD 22.5].
- Wi-Fi is pushed from the dashboard and works at the sign-in screen
  [PRD 24.2].

**The outcome.** The lab starts each lesson in the same state. Exam PCs
open the exam site and nothing else.
**[PILOT RESULT: minutes of setup per lesson, before and after]**

**What it does not do.** Rulebox is not exam-proctoring software. It
does not watch students or record screens. It limits what the PC can
open. Use it with your exam platform, not in place of it.

**FAQ:**
- *Is it free for schools?* The software is open source under the MIT
  licence. Hosting plans are in Section 9.3 **[OWNER: confirm any
  education offer]**.
- *Does it work on Windows 10?* The installer checks each PC and tells
  you. Note that Windows 10 support ended on 14 October 2025 **[CITED]**;
  the dashboard flags PCs whose Windows is out of support [PRD 13.6].
- *Do students each need an account?* You can give each student a
  sign-in, or use one sign-in per class. Sessions are cleared at log-out.

**Internal links:** → `/features/web-apps`; → `/features/performance`;
→ `/use-cases/libraries-public-pcs`; → `/use-cases/training-centres`.

---

### 6.5 Clinics and pharmacies

**URL:** `/use-cases/clinics-and-pharmacies`
**Primary keyword:** clinic computer lockdown · **Also:** shared
workstation healthcare Windows, pharmacy PC kiosk software, lock
reception computer
**Intent:** risk-aware; practice manager or IT contractor

| Field | Copy |
|---|---|
| Title tag | Locked Shared PCs for Clinics and Pharmacies \| Rulebox |
| Meta description | Front-desk PCs see patient data all day. Rulebox locks them to your clinic system, gives each person their own sign-in and logs every admin change. |
| H1 | The front-desk PC sees everything. Keep it to one job. |
| Sub-headline | A locked, shared workstation for reception, the dispensary and the nurses' station. |

**The problem.** A clinic PC is shared across shifts and shows patient
records all day. Healthcare is the most expensive industry for a data
breach: an average of $6.64 million in IBM's 2026 report
**[CITED, Section 7.2]**. A small clinic cannot afford one, and cannot
afford an IT team either.

**The moment.** The evening receptionist sits down. The day
receptionist's webmail is still open next to the patient system. A USB
stick someone found is in the port.

**How Rulebox solves it.**
- Own sign-in per person. Separate web logins and cookies per person,
  never shared [PRD 5.3].
- Idle timeout that locks the screen or logs the person out [PRD 4.7].
- Only the clinic system and approved tools can run [PRD 12.2].
- Downloads from web apps go only to that person's folder; executable
  files never open [PRD 7.3].
- An audit log of every administrative action: who, what, when
  [PRD 12.3].
- A lost laptop can be locked from the dashboard [PRD 24.4].

**The outcome.** No one inherits another person's session. What can run
on the PC is a short, known list.
**[PILOT RESULT]**

**What it does not do.** Rulebox does not make a clinic compliant with
HIPAA, GDPR or any other law by itself, and we hold no healthcare
certification. It is one technical control. Desktop apps with their own
file dialogs can still browse outside a person's folder in v1 [PRD 5.3].

**FAQ:**
- *Does Rulebox see patient data?* No. Rulebox manages which apps run.
  Your clinic system's data stays in that system.
- *Where is our Rulebox data stored?* **[OWNER: hosted region and
  sub-processor list]**. You can also host the backend yourself.
- *Can the doctor's own laptop stay normal?* Yes. Only enrolled PCs are
  locked, and the admin account on each PC stays normal Windows.

**Internal links:** → `/security`; → `/features/employee-sign-in`;
→ `/use-cases/hotels-front-desk`.

---

### 6.6 Call centres and BPO floors

**URL:** `/use-cases/call-centres`
**Primary keyword:** call center desktop lockdown · **Also:** lock down
agent PCs, hot desk PC software Windows, restrict call center computers
**Intent:** solution-aware; operations or IT manager

| Field | Copy |
|---|---|
| Title tag | Agent PC Lockdown for Call Centres \| Rulebox |
| Meta description | Hot desks, three shifts, one CRM. Rulebox locks agent PCs to approved apps and sites, with per-agent sign-in and staged updates across the floor. |
| H1 | Every seat ready for the next shift. |
| Sub-headline | Lock agent PCs to the CRM, the softphone and nothing else. Any agent, any seat. |

**The problem.** Hundreds of identical PCs, three shifts, high staff
turnover. Clients ask what agents can copy, open and install. Each
re-image costs a seat for half a day.

**The moment.** Shift change at 2 pm. Forty agents sit down at seats
someone else just left. Six softphones are still signed in as the last
agent.

**How Rulebox solves it.**
- Any agent signs in at any enrolled PC and gets their own apps
  [PRD 5.1].
- Per-app "data folders to reset on logout", so a desktop softphone
  forgets the last agent [PRD 5.3, 6.3].
- Clipboard read, downloads, camera and microphone are set per web app
  [PRD 24.1].
- Rollout rings: Pilot, Early, Everyone. A bad change stops at the first
  ring [PRD 24.3].
- Removing a leaver takes effect on the PCs: a revoked-employees list is
  part of what each PC stores [PRD 13.6 row 6].

**The outcome.** A seat is ready for the next agent after one log-out.
Floor-wide changes are tested on a few seats first.
**[PILOT RESULT: seat turnaround time; re-images per month]**

**What it does not do.** No screen recording, remote screen view or
usage tracking in v1. These are planned for a later version, with
privacy controls [PRD 21 Decisions 7, 8]. Shift-hour sign-in limits are
also planned [PRD 24.5].

**Internal links:** → `/features/updates-and-rollouts`;
→ `/features/web-apps`; → `/roadmap`.

---

### 6.7 Hotels and front desks

**URL:** `/use-cases/hotels-front-desk`
**Primary keyword:** hotel front desk computer lockdown · **Also:**
reception PC kiosk software, lock down front desk PC Windows
**Intent:** problem-aware; hotel manager or small group IT

| Field | Copy |
|---|---|
| Title tag | Front-Desk PC Lockdown for Hotels \| Rulebox |
| Meta description | Lock front-desk and back-office PCs to your booking system and approved sites. Each shift signs in to a clean, branded desktop. Open source. |
| H1 | A front desk that looks the same on every shift. |
| Sub-headline | Lock reception PCs to the booking system. Give each shift its own sign-in. Put your brand on the screen. |

**The problem.** The front-desk PC runs day and night, across three
shifts, with guest names and card details passing through. Night shifts
are long and the PC has a browser.

**The moment.** 3 am. A guest wants to check out. The property system
will not open because the PC is busy installing something the night
clerk downloaded.

**How Rulebox solves it.**
- The desktop carries your name, logo, colours and wallpaper [PRD 3.1].
- Only the property system, email and approved sites [PRD 6].
- Own sign-in per clerk; sessions close at log-out [PRD 5].
- Power options (Sleep, Restart, Shut down) can be switched off per
  group, so the desk PC stays on [PRD 4.7].
- Hidden admin exit: a key combination and a PIN, logged every time
  [PRD 12.4].

**The outcome.** The same approved desktop at 3 pm and 3 am.
**[PILOT RESULT]**

**What it does not do.** Rulebox is for staff PCs. For a guest-facing,
single-screen check-in kiosk, Windows' single-app kiosk mode is a better
fit today.

**Internal links:** → `/features/branding`;
→ `/use-cases/clinics-and-pharmacies`; → `/compare/windows-kiosk-mode`.

---

### 6.8 Warehouses and factory floors

**URL:** `/use-cases/warehouses-and-factories`
**Primary keyword:** shop floor PC lockdown · **Also:** warehouse
workstation kiosk Windows, factory terminal lockdown software

| Field | Copy |
|---|---|
| Title tag | Shop-Floor and Warehouse PC Lockdown \| Rulebox |
| Meta description | Shared stations for your ERP or WMS, locked to the job. Rulebox keeps working when the network drops and updates outside working hours. |
| H1 | A station that runs the line's software, and nothing else. |
| Sub-headline | Lock shared floor PCs to your ERP, WMS or label app. Built to keep working when the network does not. |

**The problem.** Floor PCs are dusty, old and shared by whoever is on
shift. The network is patchy at the far end of the building. A forced
Windows restart in the middle of a pick run stops the line.

**The moment.** The night shift's label PC restarts for an update at
1 am. Twelve pallets wait.

**How Rulebox solves it.**
- Rules are stored on the PC. Staff keep working offline, and the PC
  catches up when it reconnects [PRD 9.4, 10].
- Windows Update stays on, but installs and restarts are scheduled
  outside active hours [PRD 22.3].
- Web ERP and WMS screens open as their own windows, limited to listed
  domains [PRD 6.2].
- Label printers and drivers are pushed from the dashboard [PRD 24.2].
- The dashboard shows each PC's disk space, memory pressure and Windows
  support status [PRD 3.1, 22.6, 13.6].

**The outcome.** Stations that survive a bad network and do not restart
mid-shift. **[PILOT RESULT]**

**What it does not do.** Windows only in v1. Handheld scanners and
Android tablets are on the roadmap (Android, v2) [PRD 18]. Primary
monitor only in v1 [PRD 13.4].

---

### 6.9 NGOs, community centres and donated PCs

**URL:** `/use-cases/ngos-and-community-centres`
**Primary keyword:** free kiosk software for nonprofits · **Also:** open
source kiosk software Windows, lock down donated computers

| Field | Copy |
|---|---|
| Title tag | Open-Source PC Lockdown for NGOs and Community Centres \| Rulebox |
| Meta description | Donated PCs, volunteers and no IT budget. Rulebox is MIT-licensed, runs on 4 GB laptops and locks shared PCs to the tools your programme needs. |
| H1 | Old PCs. New volunteers every month. One simple setup. |
| Sub-headline | Free, open-source lockdown for the shared PCs your programme depends on. |

**The problem.** The PCs were donated and are slow. Volunteers change
often. Nobody on the team is an IT professional. Licence fees per device
are out of reach.

**The moment.** A new volunteer starts on Tuesday. The one person who
knew the admin password left in March.

**How Rulebox solves it.**
- MIT licence. No fee for the software. Self-hosting is allowed and
  documented [PRD 15].
- Made for 4 GB machines, with Lite mode [PRD 22].
- Add a volunteer in the dashboard; they can sign in on any centre PC
  [PRD 5].
- Works without a constant connection [PRD 9.4].
- Leaving? Remove Rulebox and the PC is normal Windows again [PRD 13.5].

**The outcome.** A setup one person can run and hand over.
**[PILOT RESULT]**

**Honest note on old Windows.** A locked PC that no longer receives
security updates is still at risk. Rulebox flags these PCs; it cannot
fix them [PRD 13.6 row 4].

---

### 6.10 Libraries and public-access PCs

**URL:** `/use-cases/libraries-public-pcs`
**Primary keyword:** library computer lockdown software · **Also:**
public access computer software Windows, public PC kiosk software

| Field | Copy |
|---|---|
| Title tag | Public-Access PC Lockdown for Libraries \| Rulebox |
| Meta description | Lock public PCs to the catalogue, approved websites and office tools. Each session ends clean. Open source and light enough for older PCs. |
| H1 | Public PCs that are clean for every visitor. |
| Sub-headline | Catalogue, approved websites and a few tools. Each session ends at log-out. |

**The problem.** Public PCs are used by hundreds of strangers. US public
libraries alone ran about 300,000 public-access computers and logged
about 240 million sessions in one year (FY2018) **[CITED, Section 7.2;
dated]**. Each session should leave nothing behind.

**The moment.** A visitor sits down and finds the last visitor's email
still open.

**How Rulebox solves it.**
- A "Visitor" sign-in with its own apps and site list; staff sign-ins
  with more [PRD 6.3].
- Log-out closes apps and clears the web session [PRD 5.3].
- Idle timeout logs out a visitor who walked away [PRD 4.7].
- Printing can be allowed per web app when printers are set up
  [PRD 24.1, 24.2].

**The outcome.** A known, short list of things each public PC can do.
**[PILOT RESULT]**

**What it does not do (be direct on this page).** Rulebox v1 has no
session timers, booking, pay-per-print or guest vouchers. A shared
visitor sign-in means visitors share one files folder unless staff clear
it. If you need those, a dedicated public-access system is a better fit
today.

---

### 6.11 Government and service counters

**URL:** `/use-cases/government-counters`
**Primary keyword:** government counter PC lockdown · **Also:** public
sector kiosk software open source, service desk workstation lockdown

| Field | Copy |
|---|---|
| Title tag | Locked Counter Workstations for Public Offices \| Rulebox |
| Meta description | Counter PCs locked to the case system. Signed policies, an audit log of every admin action, open source you can inspect and host yourself. |
| H1 | Counter PCs you can account for. |
| Sub-headline | Locked workstations with signed policies, a full audit trail and code you can read. |

**The problem.** Counter clerks handle citizens' records on shared PCs.
Auditors ask who changed what, and when. Procurement asks where the
data lives and whether the source can be inspected.

**How Rulebox solves it.**
- Every administrative action is recorded: who, what, when [PRD 12.3].
- Policies sent to PCs are signed with the organisation's key. A PC
  rejects anything with a bad signature [PRD 12.3].
- Roles: Owner, Admin, Viewer [PRD 15].
- The code is public under MIT. The backend can run on your own
  deployment [PRD 15].
- Dashboard sign-in needs a password and a PIN, with optional passkeys
  [PRD 12.3].

**The outcome.** A locked desk PC and a record of every change to it.
**[PILOT RESULT]**

**What it does not do.** No government certification or accreditation is
held. Self-hosting today means running your own Convex deployment
[PRD 15]; an on-premises, air-gapped install is not offered.

---

### 6.12 Compact stories (Tier 3)

These get shorter pages in a later phase. Same four parts.

| Use case | URL | Problem | Moment | How Rulebox helps | Honest limit |
|---|---|---|---|---|---|
| **Restaurants** | `/use-cases/restaurants` | The back-office PC and the order screen are shared by the whole team | Friday night; the order portal is buried under personal tabs | Web ordering portals as locked windows; kitchen printer pushed from the dashboard; per-person sign-in | Tablet POS is common in restaurants. Android support is planned for v2 |
| **Events and check-in desks** | `/use-cases/events-check-in` | Rented laptops, temporary staff, two days to set up | Doors open in an hour; ten laptops need the same registration site | One installer and one code per laptop; a group for "Registration"; **turn kiosk off afterwards and return the laptops as normal Windows** | Needs a first online sign-in per person on each laptop before offline use |
| **Training centres and internet cafés** | `/use-cases/training-centres` | Paying learners on shared PCs; each course needs different software | A new course starts Monday with new software | A group per course; remote install; staged rollout | No session billing or timers |

---

### 6.13 Use-case page template (for writers)

Every use-case page has these blocks, in this order. The design pass
decides how they look.

1. `hero` — H1, sub-headline, primary and secondary call to action
2. `scene` — "the moment" (with the illustration note)
3. `problem` — 3 short points, one cited number if we have a real one
4. `how` — 4 to 6 feature points, each linked to a feature page
5. `day` — what staff see, what the admin sees (two columns of text)
6. `outcome` — what changes; **[PILOT RESULT]** slot
7. `limits` — "What it does not do"
8. `faq` — 3 to 5 questions
9. `related` — 2 other use cases, 1 comparison, 1 doc
10. `cta` — closing call to action

---

## 7. The numbers block

Three rows of numbers. Never mix them. Each number on the site carries a
small source note or a link to `/numbers` (a page that lists every
number with its source; see the plan).

### 7.1 Product numbers (true today)

| Number | Label for the site | Source | Notes before publishing |
|---|---|---|---|
| **4 GB** | "Built for 4 GB RAM laptops" | [PRD 22.1] | A design goal, tested on a 4 GB VM. State "built and tested for" |
| **≈ 105 MB** | "Memory used by the Rulebox desktop at the sign-in screen" | [MEASURED] 2026-10-27, Windows 11 Pro, 4 GB VM, Lite mode, debug build, `docs/plans/phase-3-step17-results.md` | Re-measure on the release build on a real 4 GB laptop. Until then mark "test build" |
| **≈ 120 MB** | "Memory used with a person signed in, desktop idle" | [MEASURED] same run | Same note. Web apps add their own memory |
| **< 1%** | "CPU used when idle" | [MEASURED] same run: 0–0.4% | Same note |
| **1** | "One installer for every organisation" | [PRD 9.1, 15] | — |
| **≤ 25 MB** | "Installer size" | Budget in `phase-6-installer-pilot.md` | **A target, not yet measured.** Replace with the real size at first release |
| **3** | "Rollout rings: Pilot, Early, Everyone" | [PRD 24.3] | — |
| **1 click** | "Roll a group back to any earlier version" | [PRD 24.3] | — |
| **4** | "App types: winget, web app, MSI/EXE installer, portable EXE" | [PRD 6] | — |
| **8** | "Permissions you set per web app" | [PRD 24.1] | — |
| **74** | "Escape checks in our release checklist" | `phase-5-lockdown.md` | Say "checks we run". Do not say "passed" until the VM runs are recorded → **[RELEASE RESULT: n of 74 passed on build x]** |
| **1,300+** | "Automated tests" | 822 Rust + 523 Staff App tests on 2026-11-01, `docs/plans/README.md` | Recount at publish; convex and dashboard tests are extra |
| **≈ 2 s** | "Time for the agent to bring the desktop back if it crashes" | [PRD 13.6 row 3] | A design target. Measure before using |
| **SHA-256** | "Every installer is hash-checked before it runs" | [PRD 12.3] | — |
| **0** | "Things the staff desktop loads from the internet to draw itself" | [PRD 21 Decision 17] | Fonts, icons and UI are bundled |
| **MIT** | "Licence" | [PRD 21 Decision 9] | — |
| **$0** | "Software licence cost" | MIT | Hosting cost is separate (Section 9.3) |

Do **not** publish: setup time in minutes (not specified anywhere, so it
is a **[PILOT RESULT: median minutes from installer start to first
sign-in]**), device counts, uptime percentages.

### 7.2 Industry numbers (cited)

| Number | Statement | Source | Confidence |
|---|---|---|---|
| **~60%** | About 60% of confirmed breaches involved a human action (Verizon DBIR 2025) | Report home: <https://www.verizon.com/business/resources/reports/dbir/> · summary: <https://www.mimecast.com/en/blog/verizon-60-of-breaches-involve-human-error/> | Read from secondary summaries. **Check the report PDF before publishing** |
| **$4.99 M** | Global average cost of a data breach (IBM, 2026 report) | <https://www.ibm.com/reports/data-breach> · <https://newsroom.ibm.com/2026-07-29-ibm-study-one-in-four-malicious-breaches-are-ai-enabled,-costing-companies-6-million-on-average> | From search summaries of IBM pages. Check the report |
| **$6.64 M** | Average breach cost in healthcare, the highest of any industry (IBM, 2026) | Same | Same |
| **82%** | Of K-12 organisations studied reported cyber threat impacts in 18 months (CIS MS-ISAC, 2025 report; 5,000+ organisations, Jul 2023–Dec 2024) | <https://www.cisecurity.org/insights/white-papers/2025-k12-cybersecurity-report> | Use the report's exact words, "cyber threat impacts", not "breaches" |
| **14 Oct 2025** | Windows 10 reached end of support; no more free security updates | <https://support.microsoft.com/en-us/windows/windows-10-support-has-ended-on-october-14-2025-2ca8b313-1946-43d3-b55c-2b95b107f281> | First-hand |
| **~26–28%** | Share of Windows PCs still on Windows 10 in mid to late 2026 (StatCounter: 26.36% desktop, May 2026; 27.82% all platforms, Sept 2026) | <https://gs.statcounter.com/windows-version-market-share/desktop/worldwide> | Read from search summaries. Re-read the chart at publish |
| **4 GB** | Minimum RAM for Windows 11 | <https://www.microsoft.com/en-us/windows/windows-11-specifications> | First-hand |
| **Pro and up** | Windows' Assigned Access (kiosk) supports Pro, Enterprise, Education and IoT Enterprise; Home is not listed | <https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview> | First-hand |
| **~80%** | Of the world's workers do not sit at a desk (about 2.7 billion people) | Emergence Capital, "The State of Technology for the Deskless Workforce"; repeated by the World Economic Forum: <https://www.weforum.org/stories/emerging-technologies/ai-frontline-workforce/> | **(unverified)** The primary report was not opened. Microsoft uses 2 billion. Use only with "an estimated" |
| **~300,000 / ~240 M** | Public-access computers in US public libraries, and sessions on them, FY2018 | IMLS Public Libraries Survey tables: <https://www.imls.gov/sites/default/files/2021-02/fy2018_pls_tables.pdf> | Old data. Say the year |
| **$1,000–$4,000** | Cost of a legacy kiosk machine, per a kiosk software vendor | <https://www.42gears.com/products/surelock/> | A vendor's claim. Attribute it |
| **$2–$6** | Typical list price per device per month for kiosk and device-management suites, with 10 or 15 device minimums | Hexnode and Scalefusion pricing pages (Section 2.1) | First-hand, 2026-11-21 |

Not used: kiosk market-size figures. Publishers disagree widely (USD
21.85 billion to 37.68 billion for 2025), so the number proves little.

**Note for the owner (PRD mismatch).** Microsoft's page, as read today,
says consumer Extended Security Updates can protect a Windows 10 PC
"until October 12, 2027". PRD 13.6 row 4 says consumer ESU ends 13
October 2026, with an unconfirmed one-year extension. The page was read
through a summariser, so please open it and, if confirmed, update the
PRD row.

### 7.3 Numbers that must come from the pilot

| Placeholder | What to measure |
|---|---|
| **[PILOT RESULT: setup time]** | Median minutes from starting the installer to first staff sign-in |
| **[PILOT RESULT: PCs]** | Number of PCs and sites in the pilot (only with permission) |
| **[PILOT RESULT: support]** | "Fix my PC" requests per PC per month, before and after |
| **[PILOT RESULT: escapes]** | Kiosk escapes found during the pilot, and time to fix |
| **[PILOT RESULT: memory]** | Free RAM on a real 4 GB laptop, plain Windows versus Rulebox, same apps open |
| **[PILOT RESULT: quote]** | One sentence from a named person, with written consent |
| **[RELEASE RESULT: checklist]** | Escape checklist rows passed on the release build |

### 7.4 Ready-made numbers strips

**Strip A, home page (product facts):**
`4 GB` RAM is enough · `1` installer for every PC · `3` rollout rings,
`1`-click rollback · `74` escape checks per release · `MIT` licence

**Strip B, security page:**
`SHA-256` on every installer · `Signed` policies on every PC · `Every`
admin action in the audit log · `0` admin rights for staff

**Strip C, "why now" (cited):**
`~60%` of breaches involve a human action (Verizon, 2025) · `14 Oct
2025` Windows 10 support ended (Microsoft) · `~1 in 4` Windows PCs still
ran Windows 10 in 2026 (StatCounter)

---

## 8. Feature copy

### 8.1 Truth table (check before publishing any claim)

Status key: **v1** = in the v1 scope and built or being finished in the
current phases · **v1.x** = planned after v1 · **v2** = planned later.
"Built" here means "code exists per `docs/plans/README.md`"; several
items still wait for VM or laptop checks. Re-check at release.

| Claim | PRD | Status | Site label |
|---|---|---|---|
| Custom desktop, taskbar, Start menu, real windows | 4 | v1 | — |
| Per-person sign-in on any enrolled PC | 5 | v1 | — |
| Offline sign-in after a first online sign-in | 5.2 | v1 | — |
| Separate web logins per person; session cleanup at log-out | 5.3 | v1 | — |
| App types: winget, web app, MSI/EXE, portable EXE | 6 | v1 | — |
| Web apps limited to listed domains | 6.2 | v1 | — |
| Web apps in a locked-down Chrome or Edge window | 6, 13.1 | v1 (Phase 6, in progress) | "New" |
| Built-in viewers: PDF, images, audio, video, text, Office preview | 7.1 | v1 | — |
| Executables and scripts never open | 7.3 | v1 | — |
| Per-person folder and soft storage quota | 8 | v1 | Say "soft" |
| One MSI installer with a compatibility check | 9.1, 14 | v1 (Phase 6, in progress) | — |
| Desired state; offline PCs converge | 10 | v1 | — |
| Layered lockdown (standard user, allowlisting, policies, watchdog) | 12.2, 13.6 | v1 | "Full" or "Reduced" protection by Windows edition |
| Signed policies, audit log | 12.3 | v1 | — |
| Dashboard sign-in: password + PIN, optional passkey | 12.3 | v1 | — |
| Hidden admin exit with PIN | 12.4 | v1 | — |
| Kiosk on/off from the dashboard; settings restored | 9.5, 22.3 | v1 | — |
| Lite mode on 4 GB PCs | 22.5 | v1 | — |
| Per-app update modes: pinned, vendor, Rulebox-managed | 23.2 | v1 (Phase 6, in progress) | "New" |
| Web app permissions (8) | 24.1 | v1 | — |
| Wi-Fi, printer and driver profiles | 24.2 | v1 | — |
| Rollout rings and rollback | 24.3 | v1 | — |
| Lost-device lock, broadcast messages | 24.4 | v1 | — |
| Branding: name, logo, colours, wallpaper | 3.1 | v1 | — |
| Roles: Owner, Admin, Viewer | 15 | v1 (built in Phase 4) | — |
| Code-signed installer | 12.3, 16 | SignPath application pending | Say "signed" only when it is. The certificate name will be SignPath Foundation's, not "Rulebox" |
| System tray host, multi-monitor, Windows Update controls | 17 | v1.x | "Planned" |
| Remote screen view, usage tracking, shift hours | 17, 24.5 | v2 | "Planned" |
| Android | 18 | v2 | "Coming in v2" |
| `npx create-rulebox`, plugin app types | 17 | v2 | "Planned" |
| Linux, iOS | 19 | Not planned | Say "not planned" |

### 8.2 Feature blocks

Each block: **headline · one line · three points · what it does not do.**

**F1. Lockdown** — `/features/lockdown`
- *Headline:* Locked means locked.
- *One line:* Staff get a desktop with no way out to Windows settings,
  installers or a free browser.
- *Points:*
  - Staff run as a standard user with no admin rights. Only approved
    programs can start.
  - Task Manager, Run, Command Prompt, PowerShell, Registry Editor and
    the Windows key shortcuts are off for staff. The Ctrl+Alt+Del screen
    is emptied.
  - A service that staff cannot stop watches the desktop and brings it
    back if it crashes.
- *Does not do:* Protection depends on the Windows edition. The installer
  tells you "Full" or "Reduced" for each PC, and the dashboard shows it.
  Physical attacks (booting from USB) need a BIOS password and BitLocker,
  which you set up [PRD 13.1].

**F2. The staff desktop** — `/features/staff-desktop`
- *Headline:* Feels like Windows. Only simpler.
- *One line:* A taskbar, a Start menu and real windows, showing only the
  apps you approved.
- *Points:*
  - Apps open in real windows that move, resize, snap and minimise.
  - Hover a taskbar button for a live preview. Alt+Tab works.
  - Quick settings for Wi-Fi, volume, brightness and battery.
- *Does not do:* Primary monitor only in v1. Apps that hide in the
  system tray need a setting change in v1 [PRD 13.4].

**F3. Sign-in for every person** — `/features/employee-sign-in`
- *Headline:* Any person. Any Rulebox PC.
- *One line:* Each staff member signs in with their own details and gets
  their own apps, files and web logins.
- *Points:*
  - Works offline after the first online sign-in, for as long as you
    allow.
  - Repeated wrong passwords lock the account for a while and show up in
    the dashboard.
  - Log-out closes the person's apps and clears the session.
- *Does not do:* Files stay on the laptop where they were saved. Desktop
  apps with their own file dialogs can still browse outside the person's
  folder in v1.

**F4. Apps and web apps** — `/features/apps`
- *Headline:* Your apps, installed for you.
- *One line:* Pick an app in the dashboard. Rulebox installs it on every
  PC in the group, silently.
- *Points:*
  - Four kinds: apps from the winget catalogue, web apps from a URL,
    MSI/EXE installers and portable programs.
  - Paste a URL and Rulebox fetches the name and icon. The web app opens
    in its own window, limited to the domains you list.
  - Every installer is checked against its SHA-256 hash before it runs.
- *Does not do:* An installer that insists on a click cannot be silent;
  Rulebox reports "needs interaction" so you can fix the switches.

**F5. Files** — `/features/files`
- *Headline:* Double-click and it opens. Safely.
- *One line:* PDFs, pictures, music, video and Office files open in
  Rulebox's own viewers.
- *Points:*
  - A simple file explorer that shows only the signed-in person's folder.
  - Programs and scripts never open, whatever their name.
  - Storage quota per person, with a warning near the limit.
- *Does not do:* Office files are preview-only; add LibreOffice or
  OnlyOffice for editing. The quota is "soft" in v1.

**F6. The dashboard** — `/features/dashboard`
- *Headline:* Every PC, one web page.
- *One line:* See which PCs are online, what is installed, and change
  the rules for a group in seconds.
- *Points:*
  - Groups for PCs and for people. Assign apps to either.
  - Status per PC: online, disk space, memory pressure, Windows support
    state, protection level.
  - An audit log of every administrative action.
- *Does not do:* No remote screen view or usage tracking in v1.

**F7. Updates and rollouts** — `/features/updates-and-rollouts`
- *Headline:* Change one PC first. Then all of them.
- *One line:* Staged rollouts and one-click rollback for every change.
- *Points:*
  - Three rings: Pilot, Early, Everyone. Promote by hand or
    automatically when no failures are reported.
  - Per-app update choice: pinned version, the vendor's own updater, or
    Rulebox-managed versions.
  - Rulebox verifies its own updates before installing and rolls back if
    the new version fails its health check.
- *Does not do:* In v1, Rulebox updates itself only when nobody is
  signed in [PRD 23.4 v1 note].

**F8. Works offline** — `/features/offline`
- *Headline:* The internet can drop. Work does not.
- *One line:* Rules live on the PC. Changes wait and apply when it
  reconnects.
- *Points:*
  - Staff keep their apps, files and sign-in while offline.
  - The dashboard shows waiting changes as "Pending".
  - No stale commands: the PC moves to the latest desired state, not
    through a backlog.
- *Does not do:* A person who has never signed in on a PC cannot do
  their first sign-in while it is offline.

**F9. Light on old hardware** — `/features/performance`
- *Headline:* 4 GB is enough.
- *One line:* Rulebox trims Windows' background load and keeps its own
  footprint small.
- *Points:*
  - Lite mode switches on by itself on PCs with 4 GB of RAM or less.
  - Minimised web apps are suspended; idle ones close.
  - Windows Defender and Windows Update stay on. Security is not traded
    for speed.
- *Does not do:* It cannot make many heavy apps run at once on 4 GB. An
  SSD is still the biggest single improvement [PRD 22.7].

**F10. Your brand** — `/features/branding`
- *Headline:* Your name on every screen.
- *One line:* Company name, logo, colours and wallpaper on the sign-in
  screen and desktop.

**F11. Wi-Fi, printers and drivers** — `/features/wifi-and-printers`
- *Headline:* Staff cannot open Settings. They do not need to.
- *One line:* Push Wi-Fi networks, printers and drivers from the
  dashboard, per group.

**F12. Lost-device lock and messages** — `/features/lock-and-broadcast`
- *Headline:* Lost a laptop? Lock it from your chair.
- *One line:* A full-screen lock that survives restarts and works
  offline, plus banners to any group.

**F13. Back to normal Windows** — `/features/reversible`
- *Headline:* Never a one-way door.
- *One line:* Turn kiosk mode off and the PC behaves like normal Windows.
  Rulebox restores the settings it changed.
- *Points:*
  - From the dashboard, or with a hidden key combination and PIN at the
    PC.
  - Uninstalling restores the normal Windows shell.
  - Hold Shift at start-up to reach the Windows sign-in screen for
    recovery.

---

## 9. Objections and FAQ

Written as question and answer so they can be used as visible FAQ blocks.
See the plan (Section 6.4) on FAQ structured data: Google no longer shows
FAQ rich results, so these are written for people first.

### 9.1 Product

**What is Rulebox?**
An open-source kiosk OS for Windows. It turns an ordinary PC into a
locked, branded workstation. Staff sign in and can use only the apps,
websites and files you approve. You manage everything from a web
dashboard.

**Does it replace Windows?**
No. Rulebox runs on top of Windows. It replaces the Windows desktop for
one special "Staff" account and locks that account down. The
administrator account stays normal Windows.

**Which Windows versions work?**
The installer checks each PC and tells you: Windows version, edition,
free disk space and which protection level the PC can reach, "Full" or
"Reduced". **[OWNER: publish the minimum supported build once fixed.]**

**Does it work on Windows Home?**
It installs with "Reduced" protection, because Home lacks some lockdown
layers. The dashboard shows a badge on these PCs. For the strongest
lockdown, use Pro, Enterprise or Education. **(Verify against the
release: PRD 13.2 still marks some Home rows "Verify".)**

**How is this different from Windows kiosk mode?**
Windows' Assigned Access is solid and built in. It needs Pro or higher,
is set up with an XML file through Intune, a provisioning package or
PowerShell, and does not give you per-person sign-in, a web dashboard or
staged rollouts. If you need one full-screen app on one screen, use it.
If you need a shared staff desktop that you manage remotely, use Rulebox.
See `/compare/windows-kiosk-mode`.

**Can staff get out?**
That is the main thing we test. Staff have no admin rights, only
approved programs run, and each release is run against a 74-row escape
checklist. No lockdown is perfect; if you find a way out, tell us
(`/security`). **[RELEASE RESULT: checklist]**

**What happens if the internet goes down?**
Staff keep working. Rules, apps and sign-in details are stored on the
PC. Changes you make arrive when it reconnects.

**What if Rulebox itself crashes?**
A background service restarts the desktop within about two seconds
**(design target, PRD 13.6)**. If a new version keeps failing, Rulebox
goes back to the previous one.

**Can I undo it?**
Yes. Turn kiosk mode off in the dashboard, or use the hidden admin exit
at the PC. Uninstalling restores normal Windows.

**Will it slow the PC down?**
It usually has the opposite effect, because Explorer, start-up apps and
several background services are off for the Staff account. On a 4 GB
test machine the Rulebox desktop used about 120 MB when idle (test
build, 2026-10-27). **[PILOT RESULT: memory]**

**Does it support Android, macOS or Linux?**
Windows only today. Android is planned for v2. Linux is not planned.
iOS would be considered only with clear demand.

### 9.2 Security and privacy

**The agent runs as SYSTEM. Why should I trust it?**
Fair question. The code is open under MIT, the agent is written in Rust,
every installer it runs is hash-checked, and it rejects any policy that
is not signed with your organisation's key. Read the threat model in the
docs.

**What if someone takes over our dashboard account?**
Dashboard sign-in needs a password and a PIN, and the dashboard locks
again on every reopen. Passkeys are supported. Every action is in the
audit log. Policies are signed, and publisher checks can be required for
installers.

**Do you watch what staff do?**
No. v1 has no screen viewing, no screenshots and no usage tracking. If
these arrive later they will come with privacy controls.

**What data does the hosted service hold?**
Device names and status, staff names and sign-in details (passwords are
stored as hashes), your app list and rules, and the audit log. It does
not hold the content of your apps or files; files stay on the PC.
**[OWNER: confirm against the data model, add region and sub-processors:
Convex, Cloudflare, Resend.]**

**Are you SOC 2 or ISO 27001 certified?**
No. We are a small open-source project. We publish how the system works
and the code itself.

### 9.3 Pricing and pilot

**How much does it cost?**
- The software is free and open source (MIT).
- Hosting it yourself costs whatever your own backend costs.
- The hosted service is in an invite-only pilot. **[OWNER: confirm what
  the site may say. Planning document `post-phase-5-architecture-and-io.md`
  recommends a free plan of 2 devices, 25 employees, 20 apps, 3 groups,
  2 members, 30-day audit log, 1 GiB storage. Paid tiers are not priced
  yet.]**

**Suggested pricing-page wording until prices exist:**
> **Free and open source.** Run it yourself under the MIT licence.
> **Hosted by us.** Invite-only during the pilot. Pilot organisations
> pay nothing. Public plans and prices will be posted here before the
> pilot ends. No surprise bills: we will email every pilot organisation
> before anything changes.

**How do I join the pilot?**
Fill in the short form: organisation, number of PCs, what the PCs are
used for. We reply by email. **[OWNER: reply time you can keep.]**

**Is there a minimum number of PCs?**
No. (Compare: common suites start at 10 or 15 devices; Section 2.1.)

### 9.4 Open source

**Can I use it commercially?** Yes. MIT allows it.
**Can I host it myself?** Yes. You need your own Convex deployment
[PRD 15]. A one-command setup (`npx create-rulebox`) is planned.
**Can I contribute?** Yes. See `CONTRIBUTING` in the repository
**[OWNER: the file must exist before launch]**.
**Is every part MIT?** Rulebox's own code is. Third-party parts keep
their own licences, listed in `THIRD_PARTY_NOTICES.md`. Two worth
knowing: icons are Solar by 480 Design (CC BY 4.0), and the GSAP
animation library is free to use but is not an open-source licence
[PRD 25.2].

---

## 10. Open-source and security trust copy

### 10.1 Open-source page (`/open-source`)

- **H1:** Open by default.
- **Sub:** Rulebox is MIT-licensed. Read it, run it, change it.
- **Why open, in three points:**
  1. **You should be able to inspect what runs as SYSTEM.** A lockdown
     tool has deep access to a PC. Closed source asks for blind trust.
  2. **No lock-in.** Your rules are plain data. The backend can be your
     own deployment. Leaving is an uninstall.
  3. **Small organisations deserve good tools.** A school with twelve
     PCs should not need a sales call.
- **How we make money (plain):** The software is free. A paid hosted
  service is planned [PRD 21 Decision 10]. That pays for development.
- **What "open" does not mean:** The hosted service's operator tools are
  run by us. Third-party parts have their own licences.
- **Blocks:** repository link · licence · "How to self-host" doc link ·
  "Good first issues" link · third-party notices link · latest releases.
- **Call to action:** "View the source" · "Read the self-hosting guide".

### 10.2 Security page (`/security`)

- **H1:** How Rulebox protects a PC, and how it could fail.
- **Sub:** We would rather show the design than a badge.
- **Sections:**
  1. **What we defend against.** The six threats from PRD 12.1, in plain
     words: staff escaping the desktop, tampering with the agent, one
     person reading another's data, a compromised dashboard account, a
     stolen enrolment code, a network attacker.
  2. **Layers on the PC.** Standard user · approved programs only ·
     policy restrictions · a protected service · a process watchdog.
  3. **Trust in what we send.** TLS · SHA-256 on every installer ·
     policies signed with your organisation's key · optional publisher
     check · short-lived enrolment codes that you can revoke.
  4. **The dashboard.** Password plus PIN for every member · optional
     passkeys · re-lock on every reopen · 24-hour lockout after repeated
     wrong PINs · audit log.
  5. **How we test.** A 74-row escape checklist per release · automated
     tests · every allowed app tested for file-dialog and link escapes.
  6. **Known limits.** Copy the "does not do" list here in full: Home
     edition is "Reduced"; file dialogs in desktop apps (v1); physical
     attacks need BIOS password and BitLocker; an out-of-support Windows
     is still at risk.
  7. **Report a problem.** A security contact address, a
     `security.txt` file, and what to expect. **[OWNER: address and
     response time.]**
- **Numbers strip:** Strip B (Section 7.4).

### 10.3 Short trust lines (reusable)

- "Open source under MIT. Read every line that runs on your PCs."
- "Every installer is hash-checked. Every policy is signed."
- "Staff never have admin rights. Not for a second."
- "No screen recording. No usage tracking."
- "Turn it off and it is normal Windows again."
- "No certificates to show yet. Here is the code instead."

---

## 11. Comparison copy

Format rule (from Tailscale): praise what is good, compare on named
dimensions, end with "who should pick which". Every fact about another
product needs a source URL and a "checked on" date on the page.

### 11.1 Rulebox and Windows kiosk mode (Assigned Access)

**URL:** `/compare/windows-kiosk-mode`
**Title tag:** Rulebox vs Windows Kiosk Mode (Assigned Access)
**H1:** Windows kiosk mode or Rulebox: which fits your PCs?

| Dimension | Windows Assigned Access | Rulebox |
|---|---|---|
| Cost | Included in Windows | Free software (MIT); hosting separate |
| Windows editions | Pro, Enterprise, Education, IoT Enterprise [CITED] | Any edition that passes the installer check; Home gets "Reduced" protection |
| Single full-screen app | Yes, and it restarts the app if closed [CITED] | Not what Rulebox is for |
| Multi-app desktop | Yes: "restricted user experience" with a tailored Start menu and taskbar [CITED] | Yes: custom desktop, taskbar, Start menu |
| Setup | XML configuration through Intune, a provisioning package or PowerShell as SYSTEM [CITED] | One installer and an enrolment code |
| Per-person sign-in on a shared PC | Different configurations for different Windows accounts [CITED] | Built in: staff sign in inside Rulebox on any enrolled PC |
| Remote changes | Through an MDM such as Intune | Built-in web dashboard, rings and rollback |
| Built by | Microsoft, supported with Windows | A small open-source project, in pilot |

**The bottom line.**
- Pick **Windows kiosk mode** for one app on one screen (signage, a
  check-in screen), or if you already run Intune and have people who
  know it.
- Pick **Rulebox** for shared staff PCs with a few apps, people who sign
  in and out, no MDM, and PCs you want to manage from a browser.

### 11.2 Rulebox and device-management suites (Hexnode, Scalefusion, Intune)

**URLs:** `/compare/hexnode`, `/compare/scalefusion`, `/compare/intune`
(one page each; write after reading each vendor's current docs)

Shared honest summary:

| | Suites | Rulebox |
|---|---|---|
| Platforms | Many (Windows, Android, iOS, macOS and more) | Windows only (Android planned) |
| Scope | Full device management: patching, compliance, identity, remote control | One job: a locked staff desktop and its apps |
| Certifications | SOC 2, ISO 27001 shown on their sites | None |
| Price | About $2–$6 per device per month, with 10 or 15 device minimums [CITED] | Free software; hosted pilot |
| Source | Closed | Open (MIT) |
| Maturity | Thousands of customers, years in market | New, in pilot |

**The bottom line.** If you manage phones, tablets and Macs as well, or
need compliance reports and certificates, a suite is the right tool.
If you have Windows PCs that staff share and you want them locked,
friendly and cheap to run, Rulebox is built for exactly that.

### 11.3 Candidates to research before writing (not written yet)

`/compare/surelock` (42Gears), `/compare/deep-freeze` (reboot-to-restore
is a different approach to the same shared-PC problem),
`/compare/kiosk-browser-software` (KioWare, SiteKiosk). No facts about
these three are stated here because their pages were not read.

---

## 12. SEO keyword map

**Important:** search volumes and difficulty were **not measured**. No
keyword tool was available. The map below is built from how vendors
title their pages (Section 2) and from search intent. Validate with a
keyword tool and Search Console before investing in a page.

### 12.1 Intent groups

| Group | Example queries | Page type | Priority |
|---|---|---|---|
| **Category** | windows kiosk software, kiosk mode windows 11, multi app kiosk windows | Pillar page + glossary | 1 |
| **Problem** | lock down shared computer, restrict employee pc to certain apps, stop staff installing software | Use-case pages, guides | 1 |
| **Industry** | computer lab lockdown software, POS lockdown windows, library computer software | Industry pages | 2 |
| **Open source** | open source kiosk software, free kiosk software windows, open source kiosk windows | `/open-source`, pillar | 1 (low competition is likely, **unverified**) |
| **Alternative** | windows assigned access alternative, hexnode alternative, intune kiosk alternative | `/compare/*` | 2 |
| **How-to** | how to set up kiosk mode windows 11 home, how to block task manager for users, replace windows shell | Guides, blog | 2 |
| **Definition** | what is kiosk mode, what is assigned access, what is shell launcher, what is application allowlisting | Glossary | 3 |
| **Brand** | rulebox, rulebox kiosk, rulebox download | Home, download, docs | 1 (must own) |

### 12.2 Page-by-page metadata

Title tags are kept near 60 characters, descriptions near 155.

| Page | Primary keyword | Title tag | Meta description | H1 |
|---|---|---|---|---|
| `/` | windows kiosk software | Rulebox: Open-Source Kiosk OS for Windows PCs | Turn any Windows PC into a locked, branded staff workstation. Approved apps, websites and files only. Managed from the web. Open source (MIT). | Only what you allow. |
| `/product` | kiosk OS for Windows | How Rulebox Works: Agent, Staff Desktop, Dashboard | See how Rulebox locks a Windows PC: a small service, a friendly staff desktop and a web dashboard that keeps every PC in line. | One PC, three parts, your rules. |
| `/windows-kiosk-software` (pillar) | windows kiosk software | Windows Kiosk Software: A Plain Guide (2026) | What kiosk software does on Windows, single-app vs multi-app, what Windows includes for free, and when you need more. | Windows kiosk software, explained plainly. |
| `/features/lockdown` | lock down windows pc for employees | Windows PC Lockdown for Staff \| Rulebox | No admin rights, approved programs only, no Task Manager or Run box. How Rulebox keeps staff inside the desktop you built. | Locked means locked. |
| `/features/staff-desktop` | custom windows shell kiosk | A Friendly Locked Desktop for Staff \| Rulebox | A taskbar, a Start menu and real windows, showing only approved apps. Familiar to anyone who has used Windows. | Feels like Windows. Only simpler. |
| `/features/employee-sign-in` | shared pc multiple users login | Per-Person Sign-In on Shared PCs \| Rulebox | Each staff member signs in on any Rulebox PC and gets their own apps, files and web logins. Works offline too. | Any person. Any Rulebox PC. |
| `/features/apps` | remote app install windows pcs | Install Apps on Every PC from the Web \| Rulebox | Pick an app in the dashboard and Rulebox installs it silently on every PC in the group, hash-checked first. | Your apps, installed for you. |
| `/features/updates-and-rollouts` | staged rollout windows pcs | Staged Rollouts and One-Click Rollback \| Rulebox | Send a change to one test PC, then a few, then all. Roll back to any earlier version with one click. | Change one PC first. Then all of them. |
| `/features/offline` | offline kiosk software | Kiosk PCs That Keep Working Offline \| Rulebox | Rules, apps and sign-in live on the PC. Changes wait and apply when the connection returns. | The internet can drop. Work does not. |
| `/features/performance` | kiosk software for low end pc | Kiosk Software for 4 GB RAM PCs \| Rulebox | Lite mode, suspended windows and a trimmed Windows background. Rulebox is built and tested for 4 GB laptops. | 4 GB is enough. |
| `/open-source` | open source kiosk software windows | Open-Source Kiosk Software for Windows (MIT) \| Rulebox | Rulebox is MIT-licensed. Read the code that runs on your PCs, host it yourself, or let us host it. | Open by default. |
| `/security` | kiosk software security | Security: How Rulebox Protects a PC | The threat model, the lockdown layers, signed policies, hash-checked installers, and the limits we know about. | How Rulebox protects a PC, and how it could fail. |
| `/pricing` | kiosk software pricing | Pricing: Free and Open Source, Hosted Pilot \| Rulebox | The software is free under MIT. The hosted service is invite-only during the pilot. Public plans will be posted here. | Free to run. Simple to host. |
| `/download` | rulebox download | Download Rulebox for Windows | Get the Rulebox installer for Windows, with its SHA-256 checksum and steps to verify the file. | Download Rulebox for Windows. |
| `/pilot` | — | Join the Rulebox Pilot | Rulebox is invite-only during the pilot. Tell us about your PCs and we will reply by email. | Join the pilot. |
| `/compare/windows-kiosk-mode` | windows assigned access alternative | Rulebox vs Windows Kiosk Mode (Assigned Access) | A fair comparison: what Windows' built-in kiosk mode does well, where Rulebox differs, and who should pick which. | Windows kiosk mode or Rulebox: which fits your PCs? |
| `/roadmap` | — | Roadmap: What Is Built, What Is Next \| Rulebox | What Rulebox does today, what is coming in v1.x, and plans for v2 including Android. | What is built. What is next. |
| `/changelog` | — | Changelog \| Rulebox | Every Rulebox release, newest first. | Changelog |

Use-case pages: see the tables in Section 6.

### 12.3 Internal linking rules

1. **Hub and spoke.** `/use-cases/shared-staff-pcs` is the hub. Every
   industry page links to it in the first paragraph, and it links to all
   of them.
2. **Each use-case page links to:** 2 feature pages in the body, 2
   sibling use cases, 1 comparison page, 1 docs page.
3. **Each feature page links to:** the docs page that explains it, 2 use
   cases where it matters, and `/security` if it is a lockdown feature.
4. **Each glossary term** links once to the most relevant feature or
   pillar page, and the pillar links back.
5. **Anchor text is descriptive.** "computer lab lockdown" not "click
   here".
6. **Breadcrumbs** on every page below the home page.
7. **No orphan pages.** The build checks that every page has at least
   one inbound link (plan, Section 6).

### 12.4 Content library (search traffic)

**Glossary (first 15 terms, each 300–600 words, "What is X?" shape):**
kiosk mode · single-app vs multi-app kiosk · Assigned Access · Shell
Launcher · custom Windows shell · application allowlisting · AppLocker ·
App Control for Business (WDAC) · standard user account · desired state ·
rollout rings · SHA-256 checksum · code signing · WebView2 · shared
device mode.

**Guides (first 8):**
1. How to lock a Windows 11 PC to a few apps (three ways, honestly
   compared)
2. Kiosk mode on Windows Home: what works and what does not
3. A shared-PC security checklist for small offices (downloadable)
4. How to stop staff installing software on work PCs
5. Setting up a school computer lab on old PCs
6. What to do with Windows 10 PCs after end of support
7. How to verify a download with SHA-256 on Windows
8. Kiosk policy template: what to allow, what to block (downloadable)

**Blog (engineering and story, in the project's own voice):**
- Why we replaced the Windows shell, and what broke
- The 74 ways out: building a kiosk escape checklist
- Fitting a desktop into 120 MB on a 4 GB laptop
- Desired state, not commands
- Why Rulebox is MIT

---

## 13. Reusable copy blocks

Blocks are data. One block can feed a hero, a card, a meta description
or a social post. Field limits: `headline` ≤ 60 characters, `sub` ≤ 140,
`short` ≤ 160, `long` ≤ 90 words. Suggested storage is in the plan
(Section 7).

### 13.1 Core blocks

**`core.hero.home`**
- headline: Only what you allow.
- sub: Rulebox turns any Windows PC into a locked, branded workstation.
  Staff sign in and see only their approved apps, websites and files.
- short: An open-source kiosk OS for Windows. Lock shared PCs to
  approved apps, websites and files, and manage them from the web.
- long: Rulebox is an open-source kiosk OS for Windows. Install it on the
  PCs you already own. Staff sign in to a clean, branded desktop with
  only the apps, websites and files you approve. Change the rules from a
  web dashboard and every PC follows, even after being offline. Return
  to normal Windows at any time.
- proof: Built for 4 GB laptops · Works offline · MIT licence ·
  Reversible
- cta-primary: Request a pilot invite → `/pilot`
- cta-secondary: See how it works → `/product`

**`core.hero.alt-a`** (problem-led, for testing)
- headline: The staff PC that only does its job.
- sub: Lock shared Windows PCs to the apps and websites you approve.
  Manage every one from a web dashboard.

**`core.hero.alt-b`** (category-led, for search landing)
- headline: Kiosk software for Windows that staff actually like.
- sub: A locked desktop with a taskbar and Start menu, per-person
  sign-in and remote management. Open source.

**`core.what`** (three-part explainer)
- headline: One PC, three parts, your rules.
- items:
  - **The agent.** A small Windows service that enforces your rules,
    installs apps and keeps the desktop alive.
  - **The staff desktop.** What people see: sign-in, taskbar, Start
    menu, approved apps and their own files.
  - **The dashboard.** Where you manage PCs, people, apps and rules
    from any browser.

**`core.how`** (three steps)
- headline: Up and running in three steps.
- steps:
  1. **Install.** Run one installer on the PC. It checks the PC first.
  2. **Enrol.** Type the code from your dashboard.
  3. **Manage.** Add people and apps. The PC follows.
- note: Do not add a time claim until **[PILOT RESULT: setup time]**.

**`core.pillars`** — the five pillars from Section 4.4, each as
headline + one line.

**`core.reversible`**
- headline: Never a one-way door.
- sub: Turn kiosk mode off and the PC is normal Windows again.

**`core.opensource`**
- headline: Open by default.
- sub: MIT-licensed. Read the code, host it yourself, or let us host it.
- cta: View the source → **[OWNER: public repository URL]**

**`core.honest`**
- headline: What Rulebox does not do.
- items: No single-app signage mode · No screen recording or usage
  tracking · No Android yet (planned) · No compliance certificates ·
  Files do not roam between PCs yet.
- sub: We would rather you know now.

**`core.status`** (pilot banner)
- text: Rulebox is in an invite-only pilot. Request an invite →

**`core.cta.close`**
- headline: Your apps. Your rules.
- sub: Join the pilot, or read the code first.
- cta-primary: Request a pilot invite
- cta-secondary: Read the docs

### 13.2 Calls to action (the full set)

| id | Text | Goes to | Use when |
|---|---|---|---|
| `cta.pilot` | Request a pilot invite | `/pilot` | Primary, everywhere during the pilot |
| `cta.how` | See how it works | `/product` | Secondary on home and use cases |
| `cta.docs` | Read the docs | `/docs` | Secondary for technical readers |
| `cta.source` | View the source | repository | Open-source and security pages |
| `cta.download` | Download for Windows | `/download` | Docs, download, open-source pages |
| `cta.selfhost` | Host it yourself | `/docs/self-hosting` | Open-source and pricing pages |
| `cta.compare` | Compare with Windows kiosk mode | `/compare/windows-kiosk-mode` | Pillar and feature pages |
| `cta.signin` | Sign in | `app.<domain>` | Header, right side |
| `cta.contact` | Talk to us | `/contact` | Pricing and footer |

After the pilot, `cta.pilot` becomes "Start free" → `app.<domain>/sign-up`.
The site must be built so this is a one-line change.

### 13.3 Conversion paths

| Reader | Path |
|---|---|
| Owner-operator | Search → use-case page → home or `/product` → `/pilot` form → email reply → dashboard invite |
| Lone IT person | Search → pillar or comparison → `/security` → `/docs/quick-start` → `/download` → `/pilot` |
| Technical evaluator | Hacker-news style link or GitHub → `/open-source` → repository → `/docs/architecture` → self-host |
| Contributor | Repository → `/docs/contributing` → issues |

Secondary conversion on every page: a low-commitment email field,
"Tell me when Rulebox is open to everyone" (one field, double opt-in).

### 13.4 Short descriptions for other places

| Place | Text |
|---|---|
| GitHub repository description | Open-source kiosk OS for Windows. Turn any PC into a locked, branded staff workstation managed from a web dashboard. |
| Social bio (160) | Open-source kiosk OS for Windows. Lock shared staff PCs to approved apps, websites and files. Only what you allow. |
| Default social card text | Rulebox — Only what you allow. Open-source kiosk OS for Windows. |
| Email signature line | Rulebox · the staff PC that only does its job |
| 404 page | This page is not on the allowlist. (Then a search box and links home.) |

---

## 14. Sources

Read on 2026-11-21 unless noted.

**Product truth (repository)**
- `docs/prd.md` (all sections; cited as [PRD n])
- `docs/plans/README.md` (phase status, test counts)
- `docs/plans/phase-3-step17-results.md` (memory and CPU measurements)
- `docs/plans/phase-5-lockdown.md` (74-row escape checklist, per the index)
- `docs/plans/phase-6-installer-pilot.md` (MSI size budget, SignPath, pilot size)
- `docs/plans/post-phase-5-architecture-and-io.md` (recommended free-plan limits)

**Websites studied**
- <https://scalefusion.com/windows-kiosk-mode> · <https://scalefusion.com/pricing>
- <https://www.hexnode.com/> · <https://www.hexnode.com/mobile-device-management/pricing/> · <https://www.hexnode.com/blogs/explained/>
- <https://www.esper.io/>
- <https://www.42gears.com/products/surelock/>
- <https://www.jamf.com/>
- <https://www.iru.com/kandji-mdm/> (kandji.io redirects here)
- <https://fleetdm.com/> · <https://fleetdm.com/pricing>
- <https://tailscale.com/> · <https://tailscale.com/compare/wireguard>
- <https://linear.app/>
- <https://sentry.io/welcome/>
- <https://supabase.com/>
- <https://posthog.com/> · <https://posthog.com/pricing> (titles only)

**Microsoft**
- <https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview>
- <https://learn.microsoft.com/en-us/windows/configuration/assigned-access/quickstart-restricted-user-experience>
- <https://support.microsoft.com/en-us/windows/windows-10-support-has-ended-on-october-14-2025-2ca8b313-1946-43d3-b55c-2b95b107f281>
- <https://www.microsoft.com/en-us/windows/windows-11-specifications>
- <https://www.microsoft.com/en-us/security/business/microsoft-intune-pricing> (through search results)

**Statistics**
- Verizon DBIR: <https://www.verizon.com/business/resources/reports/dbir/> (figure read from <https://www.mimecast.com/en/blog/verizon-60-of-breaches-involve-human-error/> and <https://news.clearancejobs.com/2025/04/30/60-of-breaches-still-tied-to-human-mistakes-what-the-2025-dbir-means-for-fsos-and-leaders/>)
- IBM Cost of a Data Breach 2026: <https://www.ibm.com/reports/data-breach>
- CIS MS-ISAC K-12 report 2025: <https://www.cisecurity.org/insights/white-papers/2025-k12-cybersecurity-report>
- StatCounter: <https://gs.statcounter.com/windows-version-market-share/desktop/worldwide>
- IMLS FY2018 tables: <https://www.imls.gov/sites/default/files/2021-02/fy2018_pls_tables.pdf>
- Deskless workforce: <https://www.weforum.org/stories/emerging-technologies/ai-frontline-workforce/> (primary Emergence report not opened)
- Kiosk market size (not used): <https://www.grandviewresearch.com/industry-analysis/interactive-kiosk-market>

**Not verified, flagged in the text**
- Search volumes for every keyword in Section 12.
- The DBIR, IBM and StatCounter figures were read from summaries, not
  the primary documents.
- The Windows 10 consumer ESU end date (Section 7.2 note).
- Everything about PostHog beyond two page titles.
- Whether the Rulebox repository is public, and its final URL.
