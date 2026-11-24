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
    date: z.coerce.date(),
    /** A real person (plan §6.4, BlogPosting). */
    author: z.string(),
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
