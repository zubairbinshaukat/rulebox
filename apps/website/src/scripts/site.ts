/*
 * The site's only always-on script (about 2 kB). Everything here animates
 * transform and opacity only, honours prefers-reduced-motion, and uses
 * passive listeners with one requestAnimationFrame per frame. The home
 * page's scroll choreography is a separate GSAP chunk (home-motion.ts).
 */

/* Header: shared dropdown and mobile sheet */
import "./nav";

const root = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------- Detaching navbar ---------- */
let ticking = false;
const scrollers: Array<() => void> = [];
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    root.toggleAttribute("data-scrolled", window.scrollY > 12);
    for (const fn of scrollers) fn();
  });
}
window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll, { passive: true });


/* ---------- Home scroll choreography (GSAP, loaded only where needed) ----------
   home-motion.ts holds the hero hand-over, the word reveals and the "day"
   graphic. It is a separate chunk, fetched only on pages with those hooks
   and only when motion is allowed. The hero's sticky layout is switched on
   here, before first paint, so nothing jumps when GSAP arrives. */
const wide = window.matchMedia("(min-width: 960px)");
const hero = document.querySelector<HTMLElement>("[data-hero]");
if (!reduceMotion.matches && document.querySelector("[data-hero], [data-steps], [data-ink]")) {
  if (hero && wide.matches) hero.setAttribute("data-scrub", "");
  import("./home-motion")
    .then((m) => m.start())
    .catch(() => hero?.removeAttribute("data-scrub"));
}

/* ---------- "A day" graphic without motion (reduced motion) ----------
   The step nearest the middle of the viewport becomes active and the screen
   switches with it. With motion on, home-motion.ts drives it instead
   (data-live) and this observer stands down. */
document.querySelectorAll<HTMLElement>("[data-steps]").forEach((wrap) => {
  const steps = Array.from(wrap.querySelectorAll<HTMLElement>("[data-step]"));
  const stage = wrap.querySelector<HTMLElement>("[data-stage]");
  const tabs = Array.from(wrap.querySelectorAll<HTMLElement>("[data-tab]"));
  const set = (i: number) => {
    if (wrap.hasAttribute("data-live")) return;
    if (!stage || stage.dataset.active === String(i)) return;
    stage.dataset.active = String(i);
    steps.forEach((s, j) => s.toggleAttribute("data-current", i === j));
    tabs.forEach((t, j) => t.setAttribute("aria-current", i === j ? "step" : "false"));
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) set(steps.indexOf(e.target as HTMLElement));
      }
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  steps.forEach((s) => io.observe(s));
  tabs.forEach((t, j) =>
    t.addEventListener("click", () => {
      const s = steps[j];
      if (!s) return;
      // Put the step's middle on the reading line (lower on small screens,
      // where the sticky screen covers the top half).
      const r = s.getBoundingClientRect();
      const line = window.innerHeight * (wide.matches ? 0.5 : 0.72);
      window.scrollTo({ top: r.top + window.scrollY + r.height / 2 - line, behavior: reduceMotion.matches ? "auto" : "smooth" });
    }),
  );
  set(0);
});

/* ---------- Pause looping graphics while off screen ---------- */
const loops = document.querySelectorAll<HTMLElement>("[data-loop]");
if (loops.length) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.toggleAttribute("data-paused", !e.isIntersecting);
  });
  loops.forEach((l) => io.observe(l));
}

/* ---------- Copy buttons ---------- */
document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
  b.addEventListener("click", async () => {
    const target = document.getElementById(b.dataset.copy!);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent?.trim() ?? "");
      const old = b.getAttribute("aria-label") ?? "";
      b.setAttribute("aria-label", "Copied");
      b.dataset.done = "1";
      setTimeout(() => {
        b.setAttribute("aria-label", old);
        delete b.dataset.done;
      }, 1600);
    } catch {
      /* clipboard blocked: the text stays selectable */
    }
  });
});

onScroll();
export {};
