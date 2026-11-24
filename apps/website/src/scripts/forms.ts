/*
 * Progressive enhancement for every form[data-form]. Without JavaScript the
 * page shows a plain email address instead (Turnstile needs JavaScript).
 *
 * Turnstile is loaded only when a visitor first focuses a form, so pages
 * stay free of third-party scripts for everyone who just reads.
 */

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  getResponse(id: string): string | undefined;
  reset(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileReady: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (turnstileReady) return turnstileReady;
  turnstileReady = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
    s.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(s);
  });
  return turnstileReady;
}

function setMessage(form: HTMLFormElement, state: "ok" | "error" | "busy", text: string) {
  const msg = form.querySelector<HTMLElement>(".form-msg");
  if (!msg) return;
  msg.hidden = false;
  msg.dataset.state = state;
  msg.textContent = text;
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/* Inline errors instead of the browser's bubbles: aria-invalid on the
   control, a message under it, linked with aria-describedby. */
function errorFor(el: Control, create: boolean): HTMLElement | null {
  const id = `${el.id || el.name}-error`;
  let msg = document.getElementById(id);
  if (!msg && create) {
    msg = document.createElement("p");
    msg.id = id;
    msg.className = "field-error";
    const host = el.closest(".check") ?? el.closest(".field") ?? el.parentElement!;
    host.append(msg);
    const by = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", by ? `${by} ${id}` : id);
  }
  return msg;
}
function messageFor(el: Control): string {
  const v = el.validity;
  if (v.valueMissing) {
    if (el instanceof HTMLSelectElement) return "Please choose one.";
    if (el instanceof HTMLInputElement && el.type === "checkbox") return "Please tick this box to continue.";
    return "Please fill this in.";
  }
  if (v.typeMismatch && el instanceof HTMLInputElement && el.type === "email") return "Enter an email like name@work.example.";
  if (v.tooLong) return "This is too long.";
  return el.validationMessage;
}
function markInvalid(el: Control) {
  el.setAttribute("aria-invalid", "true");
  const msg = errorFor(el, true)!;
  msg.textContent = messageFor(el);
  msg.hidden = false;
}
function clearInvalid(el: Control) {
  if (el.getAttribute("aria-invalid") !== "true" || !el.validity.valid) return;
  el.removeAttribute("aria-invalid");
  const msg = errorFor(el, false);
  if (msg) msg.hidden = true;
}

/* Chevron state for browsers without the :open selector. */
document.querySelectorAll<HTMLElement>("[data-select]").forEach((wrap) => {
  const select = wrap.querySelector("select");
  if (!select) return;
  const off = () => wrap.removeAttribute("data-open");
  select.addEventListener("pointerdown", () => wrap.toggleAttribute("data-open"));
  select.addEventListener("change", off);
  select.addEventListener("blur", off);
  select.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Enter" || e.key === "Tab") off();
  });
});

function enhance(form: HTMLFormElement) {
  if (form.dataset.enhanced) return;
  form.dataset.enhanced = "1";
  const startedAt = Date.now();
  let widgetId: string | null = null;
  let box: HTMLDivElement | null = null;

  const prepare = async () => {
    if (widgetId) return;
    try {
      const ts = await loadTurnstile();
      if (widgetId) return;
      box = document.createElement("div");
      box.className = "ts-box";
      form.querySelector(".form-msg")?.before(box);
      widgetId = ts.render(box, {
        sitekey: form.dataset.sitekey,
        appearance: "interaction-only",
        action: form.dataset.form,
      });
    } catch {
      /* The submit handler explains what to do instead. */
    }
  };

  form.addEventListener("focusin", prepare, { once: true });

  const controls = () => Array.from(form.elements).filter((e): e is Control => e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement);
  form.addEventListener("input", (e) => clearInvalid(e.target as Control));
  form.addEventListener("change", (e) => clearInvalid(e.target as Control));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const invalid = controls().filter((el) => !el.closest(".hp") && !el.validity.valid);
    if (invalid.length) {
      invalid.forEach(markInvalid);
      invalid[0]!.focus();
      return;
    }
    await prepare();
    const token = widgetId && window.turnstile ? window.turnstile.getResponse(widgetId) : undefined;
    if (!token) {
      setMessage(form, "error", "Please wait a moment for the spam check, then send again.");
      return;
    }
    const data: Record<string, unknown> = Object.fromEntries(new FormData(form).entries());
    data.turnstileToken = token;
    data.elapsedMs = Date.now() - startedAt;
    delete data["cf-turnstile-response"];

    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) button.disabled = true;
    setMessage(form, "busy", "Sending…");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) {
        setMessage(form, "ok", body.message ?? "Thank you. Check your inbox.");
        form.reset();
      } else {
        setMessage(form, "error", body.message ?? "That did not work. Your text is still here; please try again.");
      }
    } catch {
      setMessage(form, "error", "We could not reach the server. Your text is still here; please try again.");
    } finally {
      if (button) button.disabled = false;
      if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
    }
  });
}

document.querySelectorAll<HTMLFormElement>("form[data-form]").forEach(enhance);

export {};
