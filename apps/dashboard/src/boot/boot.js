// The boot script: a tiny classic script in <head> that runs before the first
// paint. A separate file because the Content-Security-Policy allows no inline
// scripts. The build emits it as a hashed asset (vite.config.ts, plugin
// "rulebox-boot") and fills in the route map.
//
// 1. Applies the saved theme, so a dark-mode user never sees a light flash.
// 2. Build only: starts downloading the chunks of the screen this URL shows,
//    in parallel with the entry script instead of after it (one network round
//    trip less: ~0.5 s on a slow phone connection). A member screen without a
//    stored session preloads the sign-in screen instead, where it will land.
(function () {
  var theme = "auto";
  try {
    var saved = window.localStorage.getItem("rulebox.theme");
    if (saved === "light" || saved === "dark" || saved === "auto") theme = saved;
  } catch (e) {
    // Storage blocked: follow the system.
  }
  if (theme !== "light") document.documentElement.setAttribute("data-theme", theme);

  // { f: files, r: { routeKey: file indexes }, p: public route keys }, see route-table.ts.
  var map = /*RB_ROUTES*/ null;
  if (!map) return;

  function hasSession() {
    try {
      if (window.sessionStorage.getItem("rulebox.demo.session")) return true;
      for (var i = 0; i < window.localStorage.length; i++) {
        var key = window.localStorage.key(i);
        if (key && key.indexOf("__convexAuthRefreshToken") === 0) return true;
      }
      return false;
    } catch (e) {
      return true; // Unknown: assume the member screen.
    }
  }

  var path = window.location.pathname.replace(/\/+$/, "") || "/";
  var key = map.r[path] ? path : path.replace(/\/[^/]+$/, "/:");
  if (!map.r[key]) return;
  if (map.p.indexOf(key) < 0 && !hasSession()) key = "/sign-in";
  var list = map.r[key] || [];
  for (var j = 0; j < list.length; j++) {
    var link = document.createElement("link");
    link.rel = "modulepreload";
    link.crossOrigin = "";
    link.href = map.f[list[j]];
    document.head.appendChild(link);
  }
})();
