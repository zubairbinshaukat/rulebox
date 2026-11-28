/**
 * The text of "Opens in" (a website in Edge or Chrome) and "Browser rules" (a Chrome or Edge program) on the App screen
 * (Phase 6 Step 16, plan 4.9). The limits list is the plain list of plan 4.9.8: what browser mode cannot do.
 */
export const appBrowserStrings = {
  opensIn: "Opens in",
  opensInSub: "Where employees see this website.",
  kinds: { builtin: "Rulebox window", edge: "Edge", chrome: "Chrome" },
  kindHelp: {
    builtin: "The website opens in Rulebox's own window. This is the default and uses the least memory.",
    edge: "The website opens in a locked-down Microsoft Edge window on PCs that have Edge.",
    chrome: "The website opens in a locked-down Google Chrome window on PCs that have Chrome. Pick the Chrome program below.",
  },
  fallbackNote: "A PC in Lite mode, and a PC where the browser is not installed, opens this website in the Rulebox window instead.",
  chromeApp: "Chrome program",
  chromeAppHint: "A Windows program whose path ends in chrome.exe. Give it to the same groups as this website: a PC without it uses the Rulebox window.",
  chromeAppPick: "Pick a program",
  chromeLoading: "Loading programs…",
  chromeNone: "There is no Chrome program yet. Add Google Chrome as a Windows program first.",
  chromeAdd: "Add a Windows program",
  chromeNeeded: "Pick the Chrome program this website opens in.",
  chromeUnusable: (name: string) => `The Chrome program “${name}” is archived or is no longer Chrome. PCs open this website in the Rulebox window until you pick another one.`,
  chromeGone: "The Chrome program this website used was deleted. PCs open it in the Rulebox window until you pick another one.",
  limitsTitle: "What browser mode cannot do",
  limits: [
    "The rules are per browser, not per app: this website's window can reach the allowed sites of every browser website on the PC. Printing, uploads and downloads are one switch for all of them.",
    "There is no Rulebox “not allowed” screen and no count of blocked requests. The browser shows its own blocked page.",
    "Downloads are off in this version.",
    "It uses more memory, and it is not available in Lite mode.",
  ],
  // ---- permissions that do nothing in a browser window (plan 4.9.3, PRD 24.1)
  permissionsBrowserNote: (browser: string) =>
    `This website opens in ${browser}. The browser enforces permissions per site, and some stay blocked there. Those switches are shown off and can't be changed while the website opens in a browser.`,
  forcedOff: {
    screenShare: "Screen sharing stays blocked in a browser window.",
    clipboardRead: "Reading the clipboard stays blocked in a browser window.",
    downloads: "Downloads are off in a browser window in this version.",
    geolocation: "Location stays blocked in a browser window.",
  },
  // ---- Browser rules (plan 4.9.7)
  rules: "Browser rules",
  rulesSub: "The sites this browser may open. Chrome and Edge are always kept up to date by the browser itself.",
  sites: "Allowed sites",
  sitesHint: "One per line, like example.com or *.example.com. Up to 200.",
  sitesEmpty: "With no allowed site the browser opens only to its own blocked page.",
  sitesTooMany: "At most 200 sites.",
  // ---- the chip editor of the browser rules (UI pass, add-app plan 13)
  chips: {
    legend: "Sites this browser may open",
    info: "Each site also includes everything under it: portal.example.com opens its sub-pages, and example.com opens mail.example.com too.",
    addLabel: "Add a site",
    addPlaceholder: "portal.example.com",
    addHint: "A site name like portal.example.com. Everything under it opens too.",
    max: "Up to 200 sites.",
    none: "No sites yet.",
    rawList: "Edit the list by hand",
    rawListInfo: "One site per line, like example.com. Up to 200.",
  },
} as const;

/**
 * The sentences for the refusals of browser settings (`invalid_argument` with a `detail`). The App screen registers them with
 * `registerDetailSentences` (lib/errors.ts).
 */
export const browserRefusalStrings = {
  browser_app_required: "Pick a Chrome program that is not archived: a Windows program of this organization whose path ends in chrome.exe.",
  not_a_browser_app: "Only Chrome or Edge can have allowed sites. The program path must end in chrome.exe or msedge.exe.",
} as const;
