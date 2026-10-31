/*
 * Rulebox web app bar: the page of the small WebView2 that sits above every web app's site.
 *
 * Built into the window by `webapp/bar.rs` (`page()`), loaded with NavigateToString, and driven by
 * `webapp/barhost.rs`. It is Rulebox's own page, never a site: the host cancels every navigation
 * of this WebView, gives it no Tauri IPC, no permissions and no network (a CSP forbids it).
 *
 *  - Left: Back, Forward, Reload (Stop while a page loads). Then the address as DISPLAY ONLY: a lock
 *    and the host in bold, the rest of the address dimmer, an ellipsis when it is long, the full
 *    address in the tooltip. There is no input of any kind and no way to type or pick an address.
 *    Right: the action slot (see `actions` below).
 *  - Everything it shows comes from the host (`{rbBar:1, ...}` posted from WebView2's CanGoBack,
 *    CanGoForward, Source and navigation events). Everything it asks for goes back as
 *    `chrome.webview.postMessage({rbBar:1, t, ...})`; the host validates it again.
 *  - Colours are the design tokens of packages/ui/src/tokens.css (bar.css; a test keeps them equal).
 *    The icons are Solar `-linear` (CC BY 4.0, THIRD_PARTY_NOTICES.md); a test checks them against
 *    `@iconify-json/solar`. Only opacity and transform ever animate; Lite mode and reduced motion
 *    turn that off.
 *  - Action slot: the host sends `actions: [{id, label, icon}]` (its registry is `ACTIONS` in
 *    `bar.rs`). Each one is an icon button with a tooltip; `icon` is a key of ICONS below. A few show
 *    in the bar (fewer in a narrow window), the rest in the "More" menu. Clicking posts `{t:"action", id}`.
 *  - Keys: the bar is a toolbar with one tab stop; Left/Right/Home/End move inside it, Escape returns
 *    to the page. Alt+Left, Alt+Right, F5 and Ctrl+R are taken by the host before they get here.
 */
(function () {
  "use strict";

  var win = window;
  var doc = document;
  var bridge = win.chrome && win.chrome.webview;
  var SVG = "http://www.w3.org/2000/svg";

  // Solar `-linear` icons, the `body` of each in @iconify-json/solar, drawn on a 24 x 24 grid.
  var ICONS = {
    back: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 12H4M10 18L4 12L10 6"/>',
    forward: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 12H20M14 18L20 12L14 6"/>',
    reload: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M3.67981 13L3.67981 11.3333C3.67981 6.73096 7.4402 3 12.0789 3C15.1178 3 17.7799 4.60136 19.2545 7M2 11.3333L3.67981 13L5.35962 11.3333"/><path d="M20.3139 11V12.6667C20.3139 17.269 16.5391 21 11.8827 21C8.83213 21 6.15995 19.3986 4.67969 17M22.0001 12.6667L20.3139 11L18.6277 12.6667"/></g>',
    stop: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M19.0068 5L5.00684 19"/><path d="M19 19L5 5"/></g>',
    lock: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M2 16C2 13.1716 2 11.7574 2.87868 10.8787C3.75736 10 5.17157 10 8 10H16C18.8284 10 20.2426 10 21.1213 10.8787C22 11.7574 22 13.1716 22 16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H8C5.17157 22 3.75736 22 2.87868 21.1213C2 20.2426 2 18.8284 2 16Z"/><circle cx="12" cy="16" r="2"/><path d="M6 10V8C6 4.68629 8.68629 2 12 2C15.3137 2 18 4.68629 18 8V10"/></g>',
    warn: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M5.31171 10.7615C8.23007 5.58716 9.68925 3 12 3C14.3107 3 15.7699 5.58716 18.6883 10.7615L19.0519 11.4063C21.4771 15.7061 22.6897 17.856 21.5937 19.428C20.4978 21 17.7864 21 12.3637 21H11.6363C6.21356 21 3.50217 21 2.40626 19.428C1.31034 17.856 2.52291 15.7061 4.94805 11.4063L5.31171 10.7615Z"/><path d="M12 8V13"/><path stroke-linejoin="round" d="M12 16H12.0001"/></g>',
    app: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M2 12C2 7.28595 2 4.92893 3.46447 3.46447C4.92893 2 7.28595 2 12 2C16.714 2 19.0711 2 20.5355 3.46447C22 4.92893 22 7.28595 22 12C22 16.714 22 19.0711 20.5355 20.5355C19.0711 22 16.714 22 12 22C7.28595 22 4.92893 22 3.46447 20.5355C2 19.0711 2 16.714 2 12Z"/><path d="M2 9.5H22"/><path d="M9 21.9797L9 9.5"/><path stroke-linejoin="round" d="M12 6H12.0001"/><path stroke-linejoin="round" d="M9 6H9.0001"/><path stroke-linejoin="round" d="M6 6H6.0001"/></g>',
    blocked: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path d="M3 10.4167C3 7.21907 3 5.62028 3.37752 5.08241C3.75503 4.54454 5.25832 4.02996 8.26491 3.00079L8.83772 2.80472C10.405 2.26824 11.1886 2 12 2C12.8114 2 13.595 2.26824 15.1623 2.80472L15.7351 3.00079C18.7417 4.02996 20.245 4.54454 20.6225 5.08241C21 5.62028 21 7.21907 21 10.4167C21 10.8996 21 11.4234 21 11.9914C21 17.6294 16.761 20.3655 14.1014 21.5273C13.38 21.8424 13.0193 22 12 22C10.9807 22 10.62 21.8424 9.89856 21.5273C7.23896 20.3655 3 17.6294 3 11.9914C3 11.4234 3 10.8996 3 10.4167Z"/><path d="M12 8V12"/><path stroke-linejoin="round" d="M12 15H12.0001"/></g>',
    more: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g>',
    info: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 17V11"/><path stroke-linejoin="round" d="M12 8H12.0001"/></g>',
    star: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M9.15316 5.40838C10.4198 3.13613 11.0531 2 12 2C12.9469 2 13.5802 3.13612 14.8468 5.40837L15.1745 5.99623C15.5345 6.64193 15.7144 6.96479 15.9951 7.17781C16.2757 7.39083 16.6251 7.4699 17.3241 7.62805L17.9605 7.77203C20.4201 8.32856 21.65 8.60682 21.9426 9.54773C22.2352 10.4886 21.3968 11.4691 19.7199 13.4299L19.2861 13.9372C18.8096 14.4944 18.5713 14.773 18.4641 15.1177C18.357 15.4624 18.393 15.8341 18.465 16.5776L18.5306 17.2544C18.7841 19.8706 18.9109 21.1787 18.1449 21.7602C17.3788 22.3417 16.2273 21.8115 13.9243 20.7512L13.3285 20.4768C12.6741 20.1755 12.3469 20.0248 12 20.0248C11.6531 20.0248 11.3259 20.1755 10.6715 20.4768L10.0757 20.7512C7.77268 21.8115 6.62118 22.3417 5.85515 21.7602C5.08912 21.1787 5.21588 19.8706 5.4694 17.2544L5.53498 16.5776C5.60703 15.8341 5.64305 15.4624 5.53586 15.1177C5.42868 14.773 5.19043 14.4944 4.71392 13.9372L4.2801 13.4299C2.60325 11.4691 1.76482 10.4886 2.05742 9.54773C2.35002 8.60682 3.57986 8.32856 6.03954 7.77203L6.67589 7.62805C7.37485 7.4699 7.72433 7.39083 8.00494 7.17781C8.28555 6.96479 8.46553 6.64194 8.82547 5.99623L9.15316 5.40838Z"/>',
  };

  var state = {
    back: false,
    forward: false,
    loading: false,
    theme: "auto",
    calm: false,
    address: { kind: "app", secure: false, host: "", rest: "", title: "" },
    actions: [],
  };
  var menuOpen = false;
  var el = {};

  function post(message) {
    message.rbBar = 1;
    try {
      if (bridge && typeof bridge.postMessage === "function") bridge.postMessage(message);
    } catch (error) {
      // The host has gone away: nothing to tell.
    }
  }

  function make(tag, attrs, parent) {
    var node = doc.createElement(tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }

  /** A Solar glyph. `name` is a key of ICONS; one that is not known draws `info`. */
  function glyph(name, className) {
    var svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (className) svg.setAttribute("class", className);
    svg.innerHTML = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : ICONS.info;
    return svg;
  }

  function iconButton(label, icon, extra) {
    var attrs = { type: "button", "aria-label": label, title: label };
    for (var key in extra) attrs[key] = extra[key];
    var node = make("button", attrs);
    node.appendChild(glyph(icon));
    return node;
  }

  function navButton(name, label, keys, icon) {
    var node = iconButton(label, icon, {
      "data-action": name,
      "aria-keyshortcuts": keys,
      title: label + " (" + keys + ")",
    });
    node.disabled = name !== "reload";
    el.nav.appendChild(node);
    el[name] = node;
    return node;
  }

  function build() {
    el.bar = make("div", { class: "bar", role: "toolbar", "aria-label": "Page navigation" }, doc.body);
    el.nav = make("div", { class: "nav" }, el.bar);
    navButton("back", "Back", "Alt+Left", "back");
    navButton("forward", "Forward", "Alt+Right", "forward");
    navButton("reload", "Reload", "F5", "reload");
    // The same button is Stop while a page loads: the second glyph swaps in by class.
    el.reload.firstChild.setAttribute("class", "i-reload");
    el.reload.appendChild(glyph("stop", "i-stop"));

    // Display only: not an input, not focusable, not selectable.
    el.address = make("div", { class: "address", role: "group", "aria-label": "Address (read only)" }, el.bar);
    var sec = make("span", { class: "sec", "aria-hidden": "true" }, el.address);
    sec.appendChild(glyph("lock", "g g-lock"));
    sec.appendChild(glyph("warn", "g g-warn"));
    sec.appendChild(glyph("app", "g g-app"));
    sec.appendChild(glyph("blocked", "g g-blocked"));
    el.host = make("span", { class: "host" }, el.address);
    el.rest = make("span", { class: "rest" }, el.address);

    el.actions = make("div", { class: "actions", role: "group", "aria-label": "App actions", hidden: "" }, el.bar);
    el.scrim = make("div", { class: "scrim", hidden: "" }, doc.body);
    el.menu = make("div", { class: "menu", role: "menu", "aria-label": "More actions", hidden: "" }, doc.body);

    el.bar.addEventListener("click", onClick);
    el.bar.addEventListener("keydown", onToolbarKey);
    el.bar.addEventListener("focusin", function (event) {
      if (event.target && event.target.tagName === "BUTTON") rove(event.target);
    });
    el.scrim.addEventListener("click", function () {
      closeMenu(false);
    });
    el.menu.addEventListener("keydown", onMenuKey);
    el.menu.addEventListener("click", onClick);
    win.addEventListener("blur", function () {
      closeMenu(false);
    });
    win.addEventListener("resize", renderActions);
  }

  // ---- state -> page -------------------------------------------------------------------

  function dark() {
    if (state.theme === "dark") return true;
    if (state.theme === "light") return false;
    return !!(win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function text(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function paint() {
    doc.documentElement.setAttribute("data-theme", dark() ? "dark" : "light");
    el.bar.setAttribute("class", "bar" + (state.loading ? " loading" : "") + (state.calm ? " calm" : ""));
    doc.body.setAttribute("class", state.calm ? "calm" : "");

    el.back.disabled = !state.back;
    el.forward.disabled = !state.forward;
    var label = state.loading ? "Stop" : "Reload";
    el.reload.setAttribute("aria-label", label);
    el.reload.setAttribute("title", state.loading ? "Stop" : "Reload (F5)");
    if (state.loading) el.reload.removeAttribute("aria-keyshortcuts");
    else el.reload.setAttribute("aria-keyshortcuts", "F5");

    var address = state.address;
    el.address.setAttribute("data-kind", address.kind);
    el.address.setAttribute("data-secure", address.secure ? "true" : "false");
    el.address.setAttribute("title", address.title);
    text(el.host, address.host);
    text(el.rest, address.rest);
    renderActions();
    keepRoving();
  }

  // ---- the action slot -----------------------------------------------------------------

  /** How many actions fit in the bar before the rest go into "More". */
  function inlineCapacity() {
    var width = win.innerWidth || 1000;
    return width < 520 ? 1 : width < 800 ? 2 : 4;
  }

  function actionButton(action, inMenu) {
    var node = make("button", {
      type: "button",
      "data-action-id": action.id,
      "aria-label": action.label,
      title: action.label,
    });
    if (inMenu) node.setAttribute("role", "menuitem");
    node.appendChild(glyph(action.icon));
    if (inMenu) {
      var name = make("span", {});
      name.textContent = action.label;
      node.appendChild(name);
    }
    return node;
  }

  function renderActions() {
    if (!el.actions) return;
    var actions = state.actions;
    var capacity = inlineCapacity();
    var shown = actions.length > capacity ? actions.slice(0, capacity - 1) : actions;
    var extra = actions.length > capacity ? actions.slice(capacity - 1) : [];
    var key = JSON.stringify([shown, extra, capacity]);
    if (el.actions.getAttribute("data-key") === key) return;
    el.actions.setAttribute("data-key", key);

    el.actions.textContent = "";
    el.menu.textContent = "";
    if (menuOpen && extra.length === 0) closeMenu(true);
    for (var i = 0; i < shown.length; i++) el.actions.appendChild(actionButton(shown[i], false));
    if (extra.length > 0) {
      var more = iconButton("More", "more", { "aria-haspopup": "menu", "aria-expanded": menuOpen ? "true" : "false", "data-more": "" });
      el.actions.appendChild(more);
      for (var j = 0; j < extra.length; j++) el.menu.appendChild(actionButton(extra[j], true));
    }
    if (shown.length + (extra.length > 0 ? 1 : 0) === 0) el.actions.setAttribute("hidden", "");
    else el.actions.removeAttribute("hidden");
  }

  function openMenu() {
    if (menuOpen) return;
    menuOpen = true;
    el.menu.removeAttribute("hidden");
    el.scrim.removeAttribute("hidden");
    var more = el.actions.querySelector("[data-more]");
    if (more) more.setAttribute("aria-expanded", "true");
    // The host grows this WebView over the page so the menu has room, and shrinks it again.
    post({ t: "menu", open: true });
    var first = el.menu.querySelector("button");
    if (first) first.focus();
  }

  function closeMenu(silent) {
    if (!menuOpen) return;
    menuOpen = false;
    el.menu.setAttribute("hidden", "");
    el.scrim.setAttribute("hidden", "");
    var more = el.actions.querySelector("[data-more]");
    if (more) {
      more.setAttribute("aria-expanded", "false");
      if (!silent) more.focus();
    }
    post({ t: "menu", open: false });
  }

  // ---- clicks and keys -----------------------------------------------------------------

  function onClick(event) {
    var target = event.target;
    var pressed = target && target.closest ? target.closest("button") : null;
    if (!pressed || pressed.disabled) return;
    // detail 0 is a click made with the keyboard (Enter or Space): focus stays in the bar then.
    var by = event.detail === 0 ? "key" : "mouse";
    var name = pressed.getAttribute("data-action");
    if (name) {
      // The Reload button is the Stop button while a page loads.
      post({ t: "nav", a: name === "reload" && state.loading ? "stop" : name, by: by });
      return;
    }
    if (pressed.hasAttribute("data-more")) {
      if (menuOpen) closeMenu(false);
      else openMenu();
      return;
    }
    var id = pressed.getAttribute("data-action-id");
    if (id) {
      if (menuOpen) closeMenu(true);
      post({ t: "action", id: id, by: by });
    }
  }

  function enabledButtons() {
    var out = [];
    var all = el.bar.querySelectorAll("button");
    for (var i = 0; i < all.length; i++) if (!all[i].disabled) out.push(all[i]);
    return out;
  }

  /** Roving tabindex: the toolbar is one tab stop, on the button used last. */
  function rove(current) {
    var all = el.bar.querySelectorAll("button");
    for (var i = 0; i < all.length; i++) all[i].setAttribute("tabindex", all[i] === current ? "0" : "-1");
  }

  function keepRoving() {
    var current = el.bar.querySelector('button[tabindex="0"]');
    if (current && !current.disabled) return;
    var list = enabledButtons();
    if (list.length > 0) rove(list[0]);
  }

  function onToolbarKey(event) {
    var key = event.key;
    if (key === "Escape") {
      if (menuOpen) closeMenu(false);
      else post({ t: "focus-page" });
      event.preventDefault();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var list = enabledButtons();
    var at = list.indexOf(doc.activeElement);
    if (at < 0 || list.length === 0) return;
    var to = -1;
    if (key === "ArrowRight") to = (at + 1) % list.length;
    else if (key === "ArrowLeft") to = (at - 1 + list.length) % list.length;
    else if (key === "Home") to = 0;
    else if (key === "End") to = list.length - 1;
    else if (key === "ArrowDown" && list[at].hasAttribute("data-more")) {
      openMenu();
      event.preventDefault();
      return;
    }
    if (to < 0) return;
    list[to].focus();
    event.preventDefault();
  }

  function onMenuKey(event) {
    var items = el.menu.querySelectorAll("button");
    var at = Array.prototype.indexOf.call(items, doc.activeElement);
    if (event.key === "ArrowDown") items[(at + 1) % items.length].focus();
    else if (event.key === "ArrowUp") items[(at - 1 + items.length) % items.length].focus();
    else if (event.key === "Home") items[0].focus();
    else if (event.key === "End") items[items.length - 1].focus();
    else if (event.key === "Escape") closeMenu(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  // ---- messages from the host ----------------------------------------------------------

  function cleanAddress(value) {
    var address = value && typeof value === "object" ? value : {};
    var kind = address.kind === "site" || address.kind === "blocked" ? address.kind : "app";
    return {
      kind: kind,
      secure: address.secure === true,
      host: typeof address.host === "string" ? address.host : "",
      rest: typeof address.rest === "string" ? address.rest : "",
      title: typeof address.title === "string" ? address.title : "",
    };
  }

  function cleanActions(value) {
    var out = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length && out.length < 12; i++) {
      var item = value[i];
      if (!item || typeof item.id !== "string" || typeof item.label !== "string") continue;
      out.push({ id: item.id, label: item.label, icon: typeof item.icon === "string" ? item.icon : "info" });
    }
    return out;
  }

  function apply(message) {
    state.back = message.back === true;
    state.forward = message.forward === true;
    state.loading = message.loading === true;
    state.theme = message.theme === "dark" || message.theme === "light" ? message.theme : "auto";
    state.calm = message.calm === true;
    state.address = cleanAddress(message.address);
    state.actions = cleanActions(message.actions);
    paint();
  }

  if (!doc.body) return;
  build();
  paint();
  if (bridge && typeof bridge.addEventListener === "function") {
    bridge.addEventListener("message", function (event) {
      var data = event && event.data;
      if (data && typeof data === "object" && data.rbBar === 1) apply(data);
    });
  }
  // The listener is in place: now the host may send what it has.
  post({ t: "ready" });
})();
