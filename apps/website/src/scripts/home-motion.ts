/*
 * Scroll choreography for the home page (PRD Section 25: GSAP + ScrollTrigger,
 * transform and opacity only). Loaded on demand by site.ts, only on pages that
 * have one of the hooks below and only when motion is allowed. Everything is
 * built inside gsap.matchMedia, so switching to reduced motion (or resizing
 * across the breakpoint) reverts every inline style and listener.
 *
 * Why GSAP here and not CSS scroll timelines: scrubbed tweens are smoothed
 * (the value eases towards the scroll position instead of jumping with each
 * wheel notch), and each frame writes transforms straight to the few moving
 * elements instead of re-resolving a custom property over a whole subtree.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

type Undo = (() => void) | undefined;
const MOTION = "(prefers-reduced-motion: no-preference)";
const WIDE = "(min-width: 960px)";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function start() {
  const mm = gsap.matchMedia();
  mm.add({ motion: MOTION, wide: WIDE }, (ctx) => {
    const { motion, wide } = ctx.conditions as { motion: boolean; wide: boolean };
    if (!motion) return;
    const undo = [wide ? hero() : undefined, statement(), ink(), days(wide)];
    return () => undo.forEach((fn) => fn?.());
  });
}

/* ---------- Hero: product shot that grows (photo look, default) ----------
   One sequence, one timeline. At rest the photo leads, beside the headline,
   with the desktop overhanging its lower right. As you scroll, the headline
   lifts away and both chips tuck away, the stage widens into the space the
   headline left, the desktop grows into a full product shot across the
   right-hand column, and the photo shrinks and slides in behind it until
   only a sliver of its top edge shows. "One idea" rises into the narrower
   left column, and one chip ("Task Manager · Not allowed") comes back on the
   desktop's top edge. The CSS layout is the final frame; the resting frame
   is it scaled down (see Hero.astro), so nothing is drawn larger than 1x. */

/** Where the desktop rests, in stage units: its top-left corner at 39.2% /
 *  42.5% of the stage, 52.6% of its width (keep in step with Hero.astro). */
const WIN_REST = { left: 0.392, top: 0.425, width: 0.598 * 0.88 };
/** Final photo: this share of the desktop's width, centred behind it, its
 *  top edge PEEK px above the desktop's (a sliver of depth). */
const PHOTO_END = 0.88;
const PEEK = 16;
/** Final chip: overhangs the desktop's right edge by this much (at most the
 *  bleed, so it never gets closer to the window edge than the page margin). */
const CHIP_OUT = 20;

/** Resting frame of the stage: the scale and shift that put the final
 *  (big) stage back into the right-hand column beside the headline, plus
 *  the desktop's resting place over the photo and the end places of the
 *  photo and the chip. Same maths as the inline script in Hero.astro.
 *  Layout values only (offset*), so transforms in flight do not affect it. */
function restFrame(el: HTMLElement) {
  const stage = el.querySelector<HTMLElement>(".stage")!;
  const copy = el.querySelector<HTMLElement>(".copy")!;
  const win = el.querySelector<HTMLElement>(".window")!;
  const photo = el.querySelector<HTMLElement>(".s3")!;
  const chip = el.querySelector<HTMLElement>(".f1")!;
  const bleed = -parseFloat(getComputedStyle(stage).marginRight) || 0;
  const gap = Math.min(72, Math.max(40, window.innerWidth * 0.05));
  const S = stage.offsetWidth;
  const H = stage.offsetHeight;
  const right = stage.offsetLeft + S - bleed;
  const left = copy.offsetLeft + copy.offsetWidth + gap;
  const s0 = Math.min(1, (right - left) / S);

  const wl = win.offsetLeft;
  const wt = win.offsetTop;
  const ww = win.offsetWidth;
  const wh = win.offsetHeight;
  const wr = (WIN_REST.width * S) / ww;
  const wx = WIN_REST.left * S - wl;
  const wy = WIN_REST.top * H - wt;

  // Photo: fits behind the desktop (never past its sides or bottom).
  const pw = photo.offsetWidth;
  const ph = photo.offsetHeight;
  const ps = Math.min((PHOTO_END * ww) / pw, (wh + PEEK - 12) / ph);
  const px = wl + (ww - ps * pw) / 2 - photo.offsetLeft;
  const py = wt - PEEK - photo.offsetTop;

  // Chip: centred on the desktop's top edge, at its right.
  const cx = wl + ww + Math.min(CHIP_OUT, bleed) - chip.offsetWidth - chip.offsetLeft;
  const cy = wt - chip.offsetHeight / 2 - chip.offsetTop;

  el.style.setProperty("--s0", s0.toFixed(4));
  el.style.setProperty("--x0", `${-bleed}px`);
  el.style.setProperty("--wr", wr.toFixed(4));
  el.style.setProperty("--wx", `${wx}px`);
  el.style.setProperty("--wy", `${wy}px`);
  return { s0, x0: -bleed, wr, wx, wy, ps, px, py, cx, cy };
}

function heroShot(el: HTMLElement): Undo {
  el.setAttribute("data-scrub", "");
  const q = gsap.utils.selector(el);
  const stage = q(".stage")[0] as HTMLElement;
  const moving = q(".copy, .next, .stage, .window, .s3, .s3 .slab-img, .float");
  const promote = (on: boolean) => gsap.set(moving, { willChange: on ? "transform, opacity" : "auto" });

  let rest = restFrame(el);
  const s0 = () => rest.s0;
  const x0 = () => rest.x0;
  const chip = () => 1 / rest.s0;
  const r = (k: keyof typeof rest) => () => rest[k];

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: el,
      start: "top top",
      end: "bottom bottom",
      scrub: 1,
      invalidateOnRefresh: true,
      onRefreshInit: () => {
        // Measure the untransformed layout before the tweens re-record.
        rest = restFrame(el);
      },
      onToggle: (self) => promote(self.isActive),
    },
  });
  // Growth: the stage widens into the headline's space while the desktop
  // grows inside it into the full column, and the photo shrinks and slides
  // in behind it (it starts a beat later, so it reads as tucking under).
  // One long, soft curve; it ends before "One idea" is fully in, so the
  // last stretch is calm.
  tl.fromTo(stage, { x: x0, scale: s0 }, { x: 0, scale: 1, ease: "power2.inOut", duration: 0.72 }, 0.02)
    .fromTo(q(".window"), { x: r("wx"), y: r("wy"), scale: r("wr") }, { x: 0, y: 0, scale: 1, ease: "power2.inOut", duration: 0.72 }, 0)
    .fromTo(q(".s3"), { x: 0, y: 0, scale: 1 }, { x: r("px"), y: r("py"), scale: r("ps"), ease: "power2.inOut", duration: 0.7 }, 0.04)
    .fromTo(q(".s3 .slab-img"), { scale: 1, yPercent: 0 }, { scale: 0.95, yPercent: -1, ease: "power1.out", duration: 0.8 }, 0)
    // Chips tuck towards the desktop and fade, the first one first.
    .fromTo(
      q(".f1"),
      { x: 0, y: 0, scale: chip, autoAlpha: 1 },
      { x: () => stage.offsetWidth * 0.1, y: () => -stage.offsetHeight * 0.04, scale: () => chip() * 0.86, autoAlpha: 0, ease: "power2.in", duration: 0.26 },
      0.02,
    )
    // ...and it comes back on the desktop's top edge once the desktop has
    // grown: the one chip of the final frame.
    .fromTo(
      q(".f1"),
      { x: r("cx"), y: () => rest.cy + 14, scale: 0.94, autoAlpha: 0 },
      { x: r("cx"), y: r("cy"), scale: 1, autoAlpha: 1, ease: "power3.out", duration: 0.2, immediateRender: false },
      0.6,
    )
    .fromTo(
      q(".f2"),
      { x: 0, y: 0, scale: chip, autoAlpha: 1 },
      { x: () => stage.offsetWidth * 0.08, y: () => stage.offsetHeight * 0.1, scale: () => chip() * 0.86, autoAlpha: 0, ease: "power2.in", duration: 0.26 },
      0.06,
    )
    // Hand-over: the headline lifts away first, then "One idea" rises in
    // once the backdrop has moved past the middle of its growth.
    .to(q(".copy"), { y: -110, autoAlpha: 0, ease: "power2.in", duration: 0.3 }, 0)
    .fromTo(q(".next"), { y: 56, autoAlpha: 0 }, { y: 0, autoAlpha: 1, ease: "power3.out", duration: 0.34 }, 0.4);
  // Rows follow one by one. Separate tweens, not a stagger: after a refresh
  // (invalidateOnRefresh) a stagger only re-applies the first row's start.
  q(".next .rows li").forEach((li, i) => {
    tl.fromTo(li, { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, ease: "power2.out", duration: 0.22 }, 0.5 + i * 0.07);
  });
  // Hold the settled frame before the page moves on.
  tl.to({}, { duration: 0.24 });
  return () => {
    el.removeAttribute("data-scrub");
    el.style.removeProperty("--s0");
    el.style.removeProperty("--x0");
    for (const p of ["--wr", "--wx", "--wy"]) el.style.removeProperty(p);
  };
}

/* ---------- Hero hand-over (Granola), slab look ---------- */
function hero(): Undo {
  const el = document.querySelector<HTMLElement>("[data-hero]");
  if (!el) return;
  if (el.dataset.variant === "photos") return heroShot(el);
  el.setAttribute("data-scrub", "");
  const q = gsap.utils.selector(el);
  const moving = q(".copy, .next, .window, .slab, .float");
  // Promote the moving layers only while the hero is being scrubbed.
  const promote = (on: boolean) => gsap.set(moving, { willChange: on ? "transform, opacity" : "auto" });

  // Distances scale with the drawn stage, re-measured on every refresh.
  const stage = q(".stage")[0] as HTMLElement;
  const w = (f: number) => () => stage.offsetWidth * f;
  const h = (f: number) => () => stage.offsetHeight * f;

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: el,
      start: "top top",
      end: "bottom bottom",
      scrub: 0.9,
      invalidateOnRefresh: true,
      onToggle: (self) => promote(self.isActive),
    },
  });
  // 1. The supporting pictures slide in behind the desktop (Granola): the
  //    badges and slabs converge under the window, which settles slightly.
  //    (The ?hero=slabs look only; the photo look uses heroShot above.)
  tl.to(q(".f1"), { x: w(0.22), y: h(-0.34), scale: 0.9, ease: "power2.inOut", duration: 0.5 }, 0)
    .to(q(".f2"), { x: w(-0.2), y: h(-0.3), scale: 0.9, ease: "power2.inOut", duration: 0.5 }, 0.04)
    .to(q(".s1"), { x: w(0.14), y: h(-0.04), scale: 0.92, ease: "power2.inOut", duration: 0.56 }, 0)
    .to(q(".s2"), { x: w(0.06), y: h(-0.22), scale: 0.9, ease: "power2.inOut", duration: 0.56 }, 0.02)
    .to(q(".s3"), { x: w(-0.03), y: h(0.05), scale: 0.93, ease: "power2.inOut", duration: 0.56 }, 0)
    .to(q(".window"), { y: h(0.02), scale: 0.97, transformOrigin: "50% 50%", ease: "power2.inOut", duration: 0.6 }, 0)
    // 2. The headline lifts away, "One idea" rises into place, rows follow.
    .to(q(".copy"), { y: -120, autoAlpha: 0, ease: "power2.in", duration: 0.28 }, 0.02)
    .fromTo(q(".next"), { y: 48, autoAlpha: 0 }, { y: 0, autoAlpha: 1, ease: "power2.out", duration: 0.3 }, 0.36);
  q(".next .rows li").forEach((li, i) => {
    tl.fromTo(li, { y: 12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, ease: "power2.out", duration: 0.2 }, 0.46 + i * 0.07);
  });
  // Hold the settled frame for the last stretch before the page moves on.
  tl.to({}, { duration: 0.2 });
  return () => {
    el.removeAttribute("data-scrub");
  };
}

/* ---------- "The staff PC that only does its job." ----------
   The words rise one by one as the line enters; then the dark band (higher
   in the stack, solid background) slides up over the line while the line
   drifts down slowly, so it reads as passing underneath (Granola). */
function statement(): Undo {
  const section = document.querySelector<HTMLElement>(".statement");
  const giant = section?.querySelector<HTMLElement>(".giant");
  if (!section || !giant) return;
  const words = Array.from(giant.querySelectorAll<HTMLElement>(".w"));
  // Promote the line and its words only while the statement is on screen.
  ScrollTrigger.create({
    trigger: section,
    start: "top bottom",
    end: "bottom top",
    onToggle: (s) => gsap.set([giant, ...words], { willChange: s.isActive ? "transform, opacity" : "auto" }),
  });
  gsap.fromTo(
    words,
    { yPercent: 40, opacity: 0.1 },
    {
      yPercent: 0,
      opacity: 0.999,
      ease: "power2.out",
      stagger: 0.1,
      scrollTrigger: { trigger: section, start: "top 95%", end: "center 55%", scrub: 0.8 },
    },
  );
  gsap.to(giant, {
    // Starts once the line has risen and sits mid-screen; it then moves at
    // 40% of the scroll speed, so the band takes it over gradually.
    y: () => window.innerHeight * 0.42,
    scale: 0.96,
    opacity: 0.7,
    ease: "none",
    scrollTrigger: { trigger: section, start: "bottom 70%", end: "bottom top", scrub: 0.6, invalidateOnRefresh: true },
  });
  return undefined;
}
/* ---------- "The usual fixes do not fit": ink spreads word by word (Tandem) ----------
   One timeline for the whole paragraph. Each word's fade overlaps the next
   few, so the reading front is a soft gradient rather than a hard step, and
   only the handful of words inside that front are written per frame. */
function ink(): Undo {
  const text = document.querySelector<HTMLElement>("[data-ink]");
  if (!text) return;
  const words = Array.from(text.querySelectorAll<HTMLElement>(".tw"));
  gsap.set(words, { opacity: 0.18 });
  gsap.to(words, {
    // 0.999, not 1: crossing into exactly 1 drops the word's paint layer,
    // which forces a layout per word. Visually identical.
    opacity: 0.999,
    ease: "none",
    duration: 1,
    stagger: 0.25,
    scrollTrigger: { trigger: text, start: "top 80%", end: "bottom 45%", scrub: 0.7 },
  });
  return undefined;
}

/* ---------- A day on a Rulebox PC (Shufti) ----------
   A single continuous position f (0..steps-1) follows the scroll, smoothed
   with quickTo. Screens crossfade and slide, colours stack, the step text
   eases between faint and full, and a pill glides under the time tabs. */
function days(wide: boolean): Undo {
  const wrap = document.querySelector<HTMLElement>("[data-steps]");
  if (!wrap) return;
  const steps = Array.from(wrap.querySelectorAll<HTMLElement>("[data-step]"));
  const stage = wrap.querySelector<HTMLElement>("[data-stage]");
  const tabsEl = wrap.querySelector<HTMLElement>(".tabs");
  const tabs = Array.from(wrap.querySelectorAll<HTMLElement>("[data-tab]"));
  const layers = Array.from(wrap.querySelectorAll<HTMLElement>(".layer"));
  const tints = Array.from(wrap.querySelectorAll<HTMLElement>(".tint"));
  const pill = wrap.querySelector<HTMLElement>(".tab-pill");
  const pillTones = Array.from(wrap.querySelectorAll<HTMLElement>(".tab-pill > span"));
  if (!stage || !tabsEl || !pill || steps.length < 2) return;
  const last = steps.length - 1;

  wrap.setAttribute("data-live", "");
  // Promoted only while the section is on screen: scaled layers then move
  // as textures instead of being re-rastered every frame.
  const promote = (on: boolean) => gsap.set([...layers, ...tints, pill], { willChange: on ? "transform, opacity" : "auto" });

  // Step centres in page coordinates, measured on every ScrollTrigger refresh.
  let centres: number[] = [];
  let tabX: number[] = [];
  let tabW = 0;
  const measure = () => {
    centres = steps.map((s) => {
      const r = s.getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });
    tabX = tabs.map((t) => t.offsetLeft);
    tabW = tabs[0]?.offsetWidth ?? 0;
    pill.style.width = `${tabW}px`;
  };
  // The line the reader looks at: mid-screen on wide, lower on small screens
  // where the sticky screen covers the top half.
  const focus = () => window.innerHeight * (wide ? 0.5 : 0.72);
  const target = () => {
    const y = window.scrollY + focus();
    const c = (i: number) => centres[i] ?? 0;
    if (y <= c(0)) return 0;
    for (let i = 0; i < last; i++) {
      if (y <= c(i + 1)) return i + (y - c(i)) / (c(i + 1) - c(i) || 1);
    }
    return last;
  };

  // quickSetters write straight to the element (no tween objects per frame),
  // and only when the value really changed, so screens at rest cost nothing.
  // A fully transparent element is also hidden, which drops it from paint.
  const qs = (els: HTMLElement[], p: string, unit?: string) =>
    els.map((e) => {
      const set = gsap.quickSetter(e, p, unit);
      let prev = NaN;
      return (v: number) => {
        const r = Math.round(v * 1000) / 1000;
        if (r === prev) return;
        if (p === "opacity" && (r === 0) !== (prev === 0)) e.style.visibility = r === 0 ? "hidden" : "";
        prev = r;
        set(r);
      };
    });
  const layerO = qs(layers, "opacity");
  const layerY = qs(layers, "y", "px");
  const layerS = qs(layers, "scale");
  const stepO = qs(steps, "opacity");
  const tintO = qs(tints, "opacity");
  const toneO = qs(pillTones, "opacity");
  const [pillX] = qs([pill], "x", "px");

  const state = { f: 0 };
  let active = -1;
  const render = () => {
    const f = state.f;
    for (let i = 0; i <= last; i++) {
      const d = f - i;
      // Screens hand over, not blend: the outgoing one is mostly gone before
      // the incoming one is mostly in, so two screens are never both at half.
      const s = d >= 0 ? 1 - smooth(0.2, 0.55, d) : 1 - smooth(0.25, 0.6, -d);
      layerO[i]?.(s);
      layerY[i]?.(Math.max(-1, Math.min(1, -d)) * 28);
      layerS[i]?.(0.97 + 0.03 * s);
      // Text eases between faint and full across the whole gap.
      const a = 1 - smooth(0.18, 0.82, Math.abs(d));
      stepO[i]?.(0.32 + 0.679 * a); // tops out at 0.999: no layer drop, no layout
      // Colours stack in order, so two never mix to grey.
      const on = i === 0 ? 1 : smooth(i - 0.82, i - 0.18, f);
      tintO[i]?.(on);
      toneO[i]?.(on);
    }
    const i0 = Math.floor(f);
    const t = f - i0;
    const tx = (i: number) => tabX[Math.min(i, last)] ?? 0;
    pillX?.(tx(i0) + (tx(i0 + 1) - tx(i0)) * t);
    const now = Math.round(f);
    if (now !== active) {
      active = now;
      stage.dataset.active = String(now);
      tabs.forEach((tb, j) => tb.setAttribute("aria-current", j === now ? "step" : "false"));
      steps.forEach((s, j) => s.toggleAttribute("data-current", j === now));
    }
  };
  const to = gsap.quickTo(state, "f", { duration: 0.55, ease: "power3.out", onUpdate: render });

  const st = ScrollTrigger.create({
    trigger: wrap,
    start: "top bottom",
    end: "bottom top",
    onRefresh: () => {
      measure();
      state.f = target();
      to(state.f, state.f);
      render();
    },
    onUpdate: () => to(target()),
    onToggle: (self) => promote(self.isActive),
  });
  measure();
  state.f = target();
  render();

  return () => {
    st.kill();
    wrap.removeAttribute("data-live");
    gsap.set([...layers, ...tints, ...steps, ...pillTones, pill], { clearProps: "all" });
  };
}
