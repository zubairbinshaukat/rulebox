/** Display mode, web window limit and idle close (Phase 6 Step 19, plan 4.14, PRD 22.4 and 22.5). */
export const displayStrings = {
  title: "Display and memory",
  groupLead: "Lite mode keeps older PCs fast: no blur or glass, fewer animations, a lighter wallpaper. By default a PC picks its mode from its memory.",
  deviceLead: "This PC's own choice wins over its group's. Leave it on automatic to follow the group.",
  mode: "Display mode",
  modeAuto: "Automatic (by memory)",
  modeStandard: "Standard",
  modeLite: "Lite",
  /** Shown next to the group's own choice on a PC. */
  groupChoice: (mode: string) => `The group's choice: ${mode}`,
  autoNote: "Automatic: Lite on a PC with 4 GB of memory or less, Standard otherwise.",
  windowCap: "Web app windows open at once",
  windowCapHint: "At the limit the employee is asked which window to close. Nothing is closed silently.",
  capDefault: "Default (Lite 3, Standard 8)",
  capOption: (n: number) => (n === 1 ? "1 window" : `${n} windows`),
  idleClose: "Close idle web app windows",
  idleCloseHint: "A hidden, silent window with no input is closed after this time. Its app stays on the desktop and starts fresh when opened.",
  idleDefault: "Default (Lite 30 minutes, Standard never)",
  idleOff: "Never",
  idleOption: (min: number) => (min % 60 === 0 ? (min === 60 ? "1 hour" : `${min / 60} hours`) : `${min} minutes`),
  standardOnSmallPc: "This PC has 4 GB of memory or less. Standard mode may make it slow and use up its memory.",
  standardOnSmallGroup: "Standard mode on PCs with 4 GB of memory or less may make them slow.",
  saved: "Display settings saved.",
  unreportedRam: "Memory is not reported yet.",
} as const;

/** The values the idle close list offers, in minutes (5 to 240). */
export const IDLE_CLOSE_CHOICES = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240] as const;
