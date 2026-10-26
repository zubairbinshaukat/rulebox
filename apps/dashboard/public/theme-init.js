// Applies the saved theme before the first paint (no flash). A separate file
// because the Content-Security-Policy allows no inline scripts.
(function () {
  var theme = "auto";
  try {
    var saved = window.localStorage.getItem("rulebox.theme");
    if (saved === "light" || saved === "dark" || saved === "auto") theme = saved;
  } catch (e) {
    // Storage blocked: follow the system.
  }
  if (theme !== "light") document.documentElement.setAttribute("data-theme", theme);
})();
