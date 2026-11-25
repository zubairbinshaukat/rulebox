/*
 * Docs and blog prose helpers (one small module, loaded by Docs.astro and
 * the blog post page only):
 *   - copy buttons on code frames (markup from lib/code-frame.ts)
 *   - a scroll wrapper around each table, so wide tables scroll on their own
 *   - "#" links on h2/h3, so a section can be linked to
 *   - scroll-spy for the "On this page" list ([data-toc])
 * No layout work on scroll: one IntersectionObserver.
 */
/// <reference types="unplugin-icons/types/raw" />
import linkSvg from "~icons/solar/link-minimalistic-2-linear?raw";

const root = document.querySelector<HTMLElement>(".prose");

/* Copy */
document.addEventListener("click", async (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>(".code-copy");
  if (!btn) return;
  const code = btn.closest(".code")?.querySelector("pre code");
  if (!code) return;
  const label = btn.querySelector(".code-copy-text");
  try {
    await navigator.clipboard.writeText(code.textContent ?? "");
    btn.dataset.copied = "";
    if (label) label.textContent = "Copied";
  } catch {
    if (label) label.textContent = "Press Ctrl+C";
  }
  window.setTimeout(() => {
    delete btn.dataset.copied;
    if (label) label.textContent = "Copy";
  }, 1800);
});

if (root) {
  /* Tables */
  for (const t of root.querySelectorAll<HTMLTableElement>(":scope table")) {
    if (t.parentElement?.classList.contains("table-wrap")) continue;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Table");
    t.replaceWith(wrap);
    wrap.append(t);
  }

  /* Heading anchors */
  for (const h of root.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]")) {
    if (h.closest(".faq")) continue;
    const a = document.createElement("a");
    a.className = "h-anchor";
    a.href = `#${h.id}`;
    a.setAttribute("aria-label", `Link to “${h.textContent?.trim()}”`);
    a.innerHTML = linkSvg.replace("<svg", '<svg class="icon" aria-hidden="true"');
    h.append(a);
  }
}

/* Scroll-spy */
const toc = document.querySelector<HTMLElement>("[data-toc]");
if (toc && "IntersectionObserver" in window) {
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of toc.querySelectorAll<HTMLAnchorElement>("a[href^='#']")) links.set(decodeURIComponent(a.hash.slice(1)), a);
  const heads = [...links.keys()].map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  const visible = new Set<string>();
  let current = "";
  const mark = (id: string) => {
    if (id === current) return;
    links.get(current)?.removeAttribute("aria-current");
    links.get(id)?.setAttribute("aria-current", "true");
    current = id;
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      // The first heading in the reading band wins; above it, the last one passed.
      const inBand = heads.find((h) => visible.has(h.id));
      if (inBand) return mark(inBand.id);
      const passed = heads.filter((h) => h.getBoundingClientRect().top < 120);
      mark(passed.at(-1)?.id ?? heads[0]?.id ?? "");
    },
    { rootMargin: "-96px 0px -60% 0px" },
  );
  heads.forEach((h) => io.observe(h));
}
