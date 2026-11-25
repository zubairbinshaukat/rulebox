/*
 * Content collections (plan §7.1). Front matter is validated at build time;
 * a bad field fails the build. Locale-ready: everything lives under en/.
 */
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const base = {
  title: z.string().max(70),
  description: z.string().min(50).max(170),
  updated: z.coerce.date(),
  /** Drafts build, are labelled, and are never indexed. */
  draft: z.boolean().default(false),
};

const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/en/docs" }),
  schema: z.object({
    ...base,
    section: z.enum(["Start here", "Install and enrol", "Manage", "Security", "Self-hosting", "Reference", "Contributing"]),
    order: z.number().int(),
    /** Truth-table status for anything not in the current release. */
    status: z.enum(["v1", "planned"]).default("v1"),
  }),
});

const legal = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/en/legal" }),
  schema: z.object(base),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/en/blog" }),
  schema: z.object({
    ...base,
    /** Search snippet: kept to 155 characters so it is not cut off. */
    description: z.string().min(70).max(155),
    date: z.coerce.date(),
    /** A real person (plan §6.4), or the project itself until there is an
     *  author system; the project is marked up as an Organization. */
    author: z.string().default("The Rulebox team"),
    /** Canonical URL if not this page (a post first published elsewhere). */
    canonical: z.url().optional(),
    tags: z.array(z.string()).default([]),
    /** Shorter <title> for search results when the headline is long (about 60 characters). */
    seoTitle: z.string().max(60).optional(),
    /** Short lede under the title; falls back to the description. */
    lede: z.string().optional(),
  }),
});

const changelog = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/en/changelog" }),
  schema: z.object({
    ...base,
    version: z.string(),
    date: z.coerce.date(),
  }),
});

export const collections = { docs, legal, blog, changelog };
