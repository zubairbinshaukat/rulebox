import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE_URL, REPO_URL } from "../config";
import { FEATURES } from "../data/features";
import { USE_CASES } from "../data/useCases";

// A plain index of the docs and key pages for AI assistants (plan §6.3, Q8 a).
export const GET: APIRoute = async () => {
  const docs = (await getCollection("docs", (d) => !d.data.draft)).sort((a, b) => a.data.order - b.data.order);
  const posts = (await getCollection("blog", (p) => !p.data.draft)).sort((a, b) => +b.data.date - +a.data.date);
  const line = (title: string, path: string, desc: string) => `- [${title}](${SITE_URL}${path}): ${desc}`;
  const body = [
    "# Rulebox",
    "",
    "> Rulebox is an open-source (MIT) kiosk OS for Windows. It turns a PC into a locked, branded staff workstation. Staff sign in and see only approved apps, websites and files. Administrators manage every PC from a web dashboard. It is in invite-only early access.",
    "",
    "## Key pages",
    line("How it works", "/product", "The agent, the staff desktop and the dashboard."),
    line("Security", "/security", "Threat model, lockdown layers, signed policies, known limits."),
    line("Pricing", "/pricing", "Free and open source; hosted early access is invite-only and free."),
    line("Roadmap", "/roadmap", "What is in v1, what is planned, what is not planned."),
    line("Numbers", "/numbers", "Every number on the site with its source."),
    line("Compare with Windows kiosk mode", "/compare/windows-kiosk-mode", "A fair comparison with Assigned Access."),
    `- [Source code](${REPO_URL}): MIT-licensed repository.`,
    "",
    "## Features",
    ...FEATURES.map((f) => line(f.name, `/features/${f.slug}`, f.oneLine)),
    "",
    "## Use cases",
    ...USE_CASES.map((u) => line(u.name, `/use-cases/${u.slug}`, u.sub)),
    "",
    "## Docs",
    ...docs.map((d) => line(d.data.title, `/docs/${d.id}`, d.data.description)),
    "",
    "## Guides (blog)",
    ...posts.map((p) => line(p.data.title, `/blog/${p.id}`, p.data.description)),
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
