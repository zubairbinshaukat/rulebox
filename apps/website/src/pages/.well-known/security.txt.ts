import type { APIRoute } from "astro";
import { SECURITY_EMAIL, SITE_URL } from "../../config";

// RFC 9116. Expires one year after each build, so a rebuild keeps it fresh.
export const GET: APIRoute = () => {
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = [
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Expires: ${expires}`,
    `Preferred-Languages: en`,
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    `Policy: ${SITE_URL}/security/disclosure`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
