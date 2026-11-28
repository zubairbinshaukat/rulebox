/*
 * Header navigation: one shared, morphing dropdown (desktop) and the mobile
 * sheet. About 1.5 kB gzipped, no dependencies.
 *
 * Desktop model: a single stage (.dd) under the nav holds every panel.
 * Opening a different trigger while the stage is open never closes it:
 * the clip-path box morphs to the new panel's size and position, the old
 * panel slides out one way and the new one in from the other side, and
 * the caret glides to the trigger. Only clip-path, transform and opacity
 * animate. Hover uses short intent delays; focus, keyboard and touch work.
 */

const root = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const desktop = window.matchMedia("(min-width: 961px)");

const nav = document.querySelector<HTMLElement>("[data-nav]");
const navMain = document.querySelector<HTMLElement>("[data-dd-nav]");
const dd = document.querySelector<HTMLElement>("[data-dd]");
const clip = document.querySelector<HTMLElement>("[data-dd-clip]");

if (nav && navMain && dd && clip) setupDropdown(nav, navMain, dd, clip);
setupMobile();

function setupDropdown(nav: HTMLElement, navMain: HTMLElement, dd: HTMLElement, clip: HTMLElement) {
  const triggers = Array.from(navMain.querySelectorAll<HTMLButtonElement>("[data-dd-trigger]"));
  const order = triggers.map((t) => t.dataset.ddTrigger!);
  const panels = new Map<string, HTMLElement>();
  dd.querySelectorAll<HTMLElement>("[data-dd-panel]").forEach((p) => panels.set(p.dataset.ddPanel!, p));
  const sizes = new Map<string, { w: number; h: number }>();
  const lastX = new Map<string, number>();
  let maxW = 0;
  let maxH = 0;

  let active: string | null = null;
  let openedAt = 0;
  let openedByHover = false;
  let openTimer = 0;
  let closeTimer = 0;

  const OPEN_DELAY = 90;
  const SWITCH_DELAY = 60;
  const CLOSE_DELAY = 200;
  const SLIDE = 56;

  const triggerOf = (id: string) => triggers[order.indexOf(id)]!;
  const focusables = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  };

  /* Sizes are read when the stage is first opened, not at load: reading
     offsetWidth/offsetHeight forces a full-page layout, which at load landed
     right after first paint (about 150 ms on the home page) for a menu most
     visits never open. After that first read they are kept up to date. */
  let measured = false;
  function ensureMeasured() {
    if (measured) return;
    measured = true;
    measure();
  }

  function measure() {
    maxW = 0;
    maxH = 0;
    for (const [id, p] of panels) {
      const s = { w: p.offsetWidth, h: p.offsetHeight };
      sizes.set(id, s);
      maxW = Math.max(maxW, s.w);
      maxH = Math.max(maxH, s.h);
    }
    dd.style.setProperty("--dd-w", `${maxW}px`);
    dd.style.setProperty("--dd-h", `${maxH}px`);
    if (active) layout(active);
  }

  function geometry(id: string) {
    const navBox = nav.getBoundingClientRect();
    const t = triggerOf(id).getBoundingClientRect();
    const { w, h } = sizes.get(id)!;
    const stageW = dd.clientWidth;
    /* Keep the panel inside the bar's content edges (where the logo starts). */
    const edge = Math.max(8, parseFloat(getComputedStyle(nav).paddingLeft) - 12);
    const cx = Math.round(t.left + t.width / 2 - navBox.left);
    const x = Math.round(Math.min(Math.max(cx - w / 2, edge), stageW - w - edge));
    return { x, w, h, cx, stageW };
  }

  /* Morph the shared box to panel `id` and park the caret under its trigger. */
  function layout(id: string) {
    const { x, w, h, cx, stageW } = geometry(id);
    const r = stageW - x - w;
    const b = maxH - h;
    dd.style.setProperty("--clip-o", `inset(0px ${r}px ${b}px ${x}px round 18px)`);
    dd.style.setProperty("--clip-i", `inset(1px ${r + 1}px ${b + 1}px ${x + 1}px round 17px)`);
    dd.style.setProperty("--shadow-t", `translate(${x}px, 0px) scale(${w / maxW}, ${h / maxH})`);
    dd.style.setProperty("--arrow-x", `${cx - 6}px`);
    const p = panels.get(id)!;
    p.style.setProperty("--px", `${x}px`);
    lastX.set(id, x);
    return x;
  }

  function loadImages(p: HTMLElement) {
    p.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
      img.src = img.dataset.src!;
      img.removeAttribute("data-src");
    });
  }

  function setExpanded(id: string | null) {
    for (const t of triggers) t.setAttribute("aria-expanded", String(t.dataset.ddTrigger === id));
  }

  function open(id: string, byHover = false) {
    clearTimers();
    if (!desktop.matches || active === id) return;
    const p = panels.get(id);
    if (!p) return;
    ensureMeasured();
    loadImages(p);

    if (!active) {
      /* From closed: place everything without animating, then fade in. */
      dd.setAttribute("data-instant", "");
      for (const [pid, other] of panels) {
        other.dataset.state = pid === id ? "in" : "out";
        other.inert = pid !== id;
      }
      layout(id);
      void dd.offsetWidth;
      dd.removeAttribute("data-instant");
      dd.setAttribute("data-open", "");
      openedAt = performance.now();
      openedByHover = byHover;
    } else {
      /* Switch: slide old out, new in, in the direction of travel. */
      const prevId = active;
      const prev = panels.get(prevId)!;
      const dir = Math.sign(order.indexOf(id) - order.indexOf(prevId)) || 1;
      const s = reduceMotion.matches ? 0 : SLIDE;
      const x = geometry(id).x;
      p.style.transition = "none";
      p.style.setProperty("--px", `${x + dir * s}px`);
      void p.offsetWidth;
      p.style.transition = "";
      layout(id);
      p.dataset.state = "in";
      p.inert = false;
      prev.dataset.state = "out";
      prev.inert = true;
      prev.style.setProperty("--px", `${(lastX.get(prevId) ?? 0) - dir * s}px`);
    }
    active = id;
    setExpanded(id);
  }

  function close() {
    clearTimers();
    if (!active) return;
    for (const p of panels.values()) p.inert = true;
    dd.removeAttribute("data-open");
    active = null;
    setExpanded(null);
  }

  const scheduleClose = (ms = CLOSE_DELAY) => {
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(close, ms);
  };

  /* ----- Pointer (hover intent for mouse; touch and pen use click) ----- */
  for (const t of triggers) {
    const id = t.dataset.ddTrigger!;
    t.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      clearTimers();
      if (active === id) return;
      openTimer = window.setTimeout(() => open(id, true), active ? SWITCH_DELAY : OPEN_DELAY);
    });
    t.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      clearTimeout(openTimer);
      scheduleClose();
    });
    t.addEventListener("click", () => {
      const justHovered = openedByHover && performance.now() - openedAt < 600;
      if (active === id && !justHovered) close();
      else open(id);
      openedByHover = false;
    });
    t.addEventListener("focus", () => {
      if (t.matches(":focus-visible")) open(id);
    });
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey && active === id)) {
        e.preventDefault();
        open(id);
        focusables(panels.get(id)!)[0]?.focus();
      }
    });
  }
  clip.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") clearTimers();
  });
  clip.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") scheduleClose();
  });
  navMain.querySelectorAll<HTMLElement>(".nav-list a").forEach((a) =>
    a.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse" && active) scheduleClose(120);
    }),
  );
  document.addEventListener("pointerdown", (e) => {
    if (active && !navMain.contains(e.target as Node)) close();
  });

  /* ----- Keyboard inside a panel ----- */
  clip.addEventListener("keydown", (e) => {
    if (!active) return;
    const items = focusables(panels.get(active)!);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      const id = active;
      close();
      triggerOf(id).focus({ preventScroll: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[n]?.focus();
    } else if (e.key === "Tab" && e.shiftKey && i === 0) {
      e.preventDefault();
      triggerOf(active).focus();
    } else if (e.key === "Tab" && !e.shiftKey && i === items.length - 1) {
      /* Leave the panel to whatever follows its trigger in the bar. */
      e.preventDefault();
      const bar = focusables(navMain.querySelector<HTMLElement>(".nav-list")!);
      const next = bar[bar.indexOf(triggerOf(active)) + 1];
      if (next) next.focus();
      else close();
      if (next && !next.hasAttribute("data-dd-trigger")) close();
    }
  });
  navMain.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (active && (!to || !navMain.contains(to))) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !active) return;
    const id = active;
    const hadFocus = navMain.contains(document.activeElement);
    close();
    if (hadFocus) triggerOf(id).focus({ preventScroll: true });
  });

  /* ----- Sizes ----- */
  document.fonts?.ready.then(() => measured && measure()).catch(() => {});
  let raf = 0;
  window.addEventListener(
    "resize",
    () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!desktop.matches) close();
        else if (measured) measure();
      });
    },
    { passive: true },
  );
}

/* ---------- Mobile sheet ---------- */
function setupMobile() {
  const toggle = document.querySelector<HTMLButtonElement>("[data-mobile-toggle]");
  const sheet = document.querySelector<HTMLElement>("[data-mobile-menu]");
  if (!toggle || !sheet) return;
  const outside = () => Array.from(document.querySelectorAll<HTMLElement>("body > main, body > footer, .skip-link"));

  function set(open: boolean, restoreFocus = true) {
    if (!toggle || !sheet) return;
    if (open === (toggle.getAttribute("aria-expanded") === "true")) return;
    toggle.setAttribute("aria-expanded", String(open));
    sheet.hidden = !open;
    root.style.overflow = open ? "hidden" : "";
    for (const el of outside()) el.inert = open;
    if (open) sheet.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
    else if (restoreFocus) toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener("click", () => set(toggle.getAttribute("aria-expanded") !== "true"));
  sheet.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) set(false, false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") set(false);
  });
  desktop.addEventListener("change", (e) => {
    if (e.matches) set(false, false);
  });
}

export {};
