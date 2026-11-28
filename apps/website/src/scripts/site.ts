/*
 * The site's only always-on script (about 2 kB). Everything here animates
 * transform and opacity only, honours prefers-reduced-motion, and uses
 * passive listeners with one requestAnimationFrame per frame. The home
 * page's scroll choreography is a separate GSAP chunk (home-motion.ts).
 */

/* Header: shared dropdown and mobile sheet */
import "./nav";
/* Forms (submit handler; Turnstile loads only when a form is focused). Part of this
   script, not its own <script>: as a separate import it was a second link in the
   request chain (HTML, form script, shared chunk). About 1.8 kB gzipped; it does
   nothing on pages without a form[data-form]. */
import "./forms";

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
   graphic. It is a separate chunk (about 47 kB gzipped), fetched only on pages
   with those hooks and only when motion is allowed. The hero's sticky layout
   is switched on here, before first paint, so nothing jumps when GSAP arrives.

   It is fetched AFTER the page has loaded and the browser is idle, not while
   the first screen is being built: nothing in it is needed for the first paint
   (every start state is set in CSS or is below the fold), and fetching it from
   this script put a second link in the request chain (HTML, this script, GSAP)
   that competed with the LCP image, CSS and fonts. The first scroll, wheel,
   touch or key press loads it at once, so the choreography is ready when the
   visitor starts to move. */
const wide = window.matchMedia("(min-width: 960px)");
const hero = document.querySelector<HTMLElement>("[data-hero]");
if (!reduceMotion.matches && document.querySelector("[data-hero], [data-steps], [data-ink]")) {
  if (hero && wide.matches) hero.setAttribute("data-scrub", "");
  let motionStarted = false;
  const startMotion = () => {
    if (motionStarted) return;
    motionStarted = true;
    for (const t of ["scroll", "wheel", "touchstart", "keydown", "pointerdown"]) window.removeEventListener(t, startMotion);
    import("./home-motion")
      .then((m) => m.start())
      .catch(() => hero?.removeAttribute("data-scrub"));
  };
  for (const t of ["scroll", "wheel", "touchstart", "keydown", "pointerdown"]) window.addEventListener(t, startMotion, { passive: true });
  const whenIdle = () => ("requestIdleCallback" in window ? window.requestIdleCallback(startMotion, { timeout: 1500 }) : setTimeout(startMotion, 300));
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
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
