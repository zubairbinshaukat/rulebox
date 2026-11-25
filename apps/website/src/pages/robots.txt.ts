import type { APIRoute } from "astro";
import { IS_PRODUCTION, SITE_URL } from "../config";

// Plan §6.3 and Q8 (a): allow every crawler, including AI crawlers, on
// production. Every other build (previews) disallows everything.
export const GET: APIRoute = () => {
  const body = IS_PRODUCTION
    ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    : `User-agent: *\nDisallow: /\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
