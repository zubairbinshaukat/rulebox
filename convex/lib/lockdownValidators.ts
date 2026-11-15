import { v, type Infer } from "convex/values";

// Phase 5 validators (plan 4.2, 4.3, 4.11, 4.16) shared by the schema, the
// builder (`lib/desired.ts`), the group configuration snapshots
// (`lib/groupConfig.ts`) and the device API. The names and values are exactly
// the ones of the Rust types in `crates/rulebox-policy` (`lockdown.rs`,
// `network.rs`, `notice.rs`); `crates/rulebox-policy/tests/vectors/lockdown.json`
// pins the shapes in both languages.

export const layerMode = v.union(v.literal("off"), v.literal("audit"), v.literal("enforce"));
export type LayerModeValue = Infer<typeof layerMode>;
export const appControlLevel = v.union(v.literal("recommendedBlocks"), v.literal("allowlist"));
export const ring = v.union(v.literal("pilot"), v.literal("early"), v.literal("everyone"));
export type RingValue = Infer<typeof ring>;
export const RINGS: readonly RingValue[] = ["pilot", "early", "everyone"];
export const usbStorageMode = v.union(v.literal("allow"), v.literal("readOnly"), v.literal("block"));
export const usbSwitch = v.union(v.literal("allow"), v.literal("block"));

const staffRestrictions = v.object({
  taskManager: v.boolean(),
  run: v.boolean(),
  commandPrompt: v.boolean(),
  registryTools: v.boolean(),
  settings: v.boolean(),
  signOut: v.boolean(),
  changePassword: v.boolean(),
  hideDrives: v.boolean(),
  accessibilityHotkeys: v.boolean(),
  officeMacros: v.boolean(),
});

const machineRestrictions = v.object({
  hideSwitchUser: v.boolean(),
  hideSignInPower: v.boolean(),
  denyElevationRequests: v.boolean(),
  hideAdminTiles: v.boolean(),
  noWakePassword: v.boolean(),
  restrictPrinterDrivers: v.boolean(),
  fileOutputPrinters: v.boolean(),
  /** `null` = leave the machine's setting alone (4.8). */
  accountLockout: v.union(v.object({ threshold: v.number(), durationMin: v.number(), windowMin: v.number() }), v.null()),
});

/**
 * `groupLockdown.settings` and `orgSettings.newGroupDefaults` (4.2, 4.3): the
 * `lockdown` section of the document WITHOUT `exceptions` (those are their own
 * rows) plus `wifiManagedOnly`, which is a group setting of the same screen.
 */
export const lockdownSettings = v.object({
  staff: staffRestrictions,
  machine: machineRestrictions,
  appLocker: v.object({ mode: layerMode }),
  appControl: v.object({ mode: layerMode, level: appControlLevel }),
  procWatch: v.object({ mode: layerMode }),
  keyboard: v.object({ winCombos: v.union(v.literal("pass"), v.literal("swallow")) }),
  usb: v.object({
    storage: usbStorageMode,
    printers: usbSwitch,
    imaging: usbSwitch,
    phones: usbSwitch,
    other: usbSwitch,
    retroactive: v.boolean(),
  }),
  accessibilityTools: v.boolean(),
  boot: v.object({ autoRecovery: v.union(v.literal("leave"), v.literal("off")), safeModeGuard: v.boolean() }),
  performance: v.object({ staffTuning: v.boolean(), kioskProfile: v.boolean(), noPrinting: v.boolean() }),
  wifiManagedOnly: v.boolean(),
  /**
   * (Step 20b) "I understand this PC may go offline": lifts the agent's `would_disconnect` refusal when "managed networks only" is on.
   * Optional and never stored as `false` (`normalizeSettings` in lockdown.ts), so settings made before it exist stay equal.
   */
  wifiManagedOnlyConfirmed: v.optional(v.boolean()),
});
export type LockdownSettings = Infer<typeof lockdownSettings>;

/** The defaults of 4.3 ("Defaults"): a new group, and an agent when a sub-key is missing. */
export const DEFAULT_LOCKDOWN_SETTINGS: LockdownSettings = {
  staff: {
    taskManager: true,
    run: true,
    commandPrompt: true,
    registryTools: true,
    settings: true,
    signOut: true,
    changePassword: true,
    hideDrives: true,
    accessibilityHotkeys: true,
    officeMacros: true,
  },
  machine: {
    hideSwitchUser: true,
    hideSignInPower: true,
    denyElevationRequests: true,
    hideAdminTiles: true,
    noWakePassword: true,
    restrictPrinterDrivers: true,
    fileOutputPrinters: true,
    accountLockout: { threshold: 10, durationMin: 15, windowMin: 15 },
  },
  appLocker: { mode: "audit" },
  appControl: { mode: "audit", level: "recommendedBlocks" },
  procWatch: { mode: "audit" },
  keyboard: { winCombos: "swallow" },
  usb: { storage: "allow", printers: "allow", imaging: "allow", phones: "allow", other: "allow", retroactive: false },
  accessibilityTools: false,
  boot: { autoRecovery: "off", safeModeGuard: true },
  performance: { staffTuning: true, kioskProfile: true, noPrinting: false },
  wifiManagedOnly: false,
};

export const exceptionLayer = v.union(v.literal("appLocker"), v.literal("procWatch"));

/** `lockdownExceptions.rule`; the rule's `id` in the document is the row id, its `appId` the row's `appId`. */
export const exceptionRule = v.object({
  kind: v.union(v.literal("publisher"), v.literal("hash"), v.literal("path")),
  publisher: v.optional(
    v.object({ subject: v.string(), product: v.optional(v.string()), fileName: v.optional(v.string()) }),
  ),
  sha256: v.optional(v.string()),
  path: v.optional(v.string()),
  layers: v.array(exceptionLayer),
});
export type ExceptionRuleValue = Infer<typeof exceptionRule>;

export const wifiSecurity = v.union(
  v.literal("open"),
  v.literal("wpa2Personal"),
  v.literal("wpa3Personal"),
  v.literal("wpa2Wpa3Personal"),
);
export const printerKind = v.union(v.literal("ipp"), v.literal("raw"), v.literal("lpr"), v.literal("share"));
/** Step 14b: how a driver package is installed, and what it is for. */
export const driverKind = v.union(v.literal("inf"), v.literal("exe"), v.literal("msi"));
export const driverClass = v.union(v.literal("printer"), v.literal("scanner"), v.literal("other"));

/** `{ v, keyId, epk, nonce, ct }` of `rulebox.seal/1` (4.18). Every binary field is base64. */
export const sealedBox = v.object({ v: v.number(), keyId: v.string(), epk: v.string(), nonce: v.string(), ct: v.string() });
export type SealedBoxValue = Infer<typeof sealedBox>;

/** A Wi-Fi passphrase at rest (4.18): the sealing key's id and `base64(nonce ‖ ciphertext)`. */
export const atRestBox = v.object({ keyId: v.string(), sealed: v.string() });

// ---- apply reports (4.11)

export const layerState = v.object({
  mode: v.string(),
  state: v.string(),
  detail: v.optional(v.string()),
});
export const layerStates = v.object({
  staff: layerState,
  machine: layerState,
  appLocker: layerState,
  appControl: layerState,
  procWatch: layerState,
  boot: layerState,
  performance: layerState,
});
export type LayerStatesValue = Infer<typeof layerStates>;

export const applyState = v.union(
  v.literal("applied"),
  v.literal("partial"),
  v.literal("refused"),
  v.literal("failed"),
  v.literal("rolledBack"),
);
export type ApplyStateValue = Infer<typeof applyState>;

// ---- physical protection (4.16)

/** `deviceReports.security`. Every field is a fixed code or a count; unknown strings are kept out by the reader. */
export const securityPosture = v.object({
  safeModeAgent: v.optional(v.boolean()),
  autoRecovery: v.optional(v.string()),
  serviceAcl: v.optional(v.string()),
  aclDrift: v.optional(v.number()),
  secureBoot: v.optional(v.string()),
  bitLocker: v.optional(v.string()),
  tpm: v.optional(v.string()),
  ciPolicies: v.optional(v.array(v.string())),
});
export type SecurityPostureValue = Infer<typeof securityPosture>;

// ---- security counters (4.2)

export const blockedCounts = v.object({
  appLocker: v.number(),
  appControl: v.number(),
  procWatch: v.number(),
  elevation: v.number(),
});
export type BlockedCountsValue = Infer<typeof blockedCounts>;
export const permissionDenial = v.object({ appId: v.string(), kind: v.string(), count: v.number() });
export type PermissionDenialValue = Infer<typeof permissionDenial>;

export const findingLayer = v.union(v.literal("appLocker"), v.literal("appControl"), v.literal("procWatch"));
export const FOLDER_CLASSES = ["windows", "programFiles", "rulebox", "userProfile", "userTemp", "removable", "network", "other"] as const;
export const findingStatus = v.union(v.literal("new"), v.literal("allowed"), v.literal("ignored"));

export const orgKeyPurpose = v.union(v.literal("signing"), v.literal("sealing"));
export const orgKeyStatus = v.union(v.literal("active"), v.literal("next"), v.literal("retired"));

export const rolloutState = v.union(v.literal("idle"), v.literal("rolling"), v.literal("halted"));
export const broadcastStyle = v.union(v.literal("banner"), v.literal("fullscreen"));
