// The fixed input of the committed signing vectors (plan Step 8 item 7):
// `scripts/gen-policy-vectors.mjs` builds, signs and writes
// `crates/rulebox-policy/tests/vectors/{signed-v2,roster-v1}.json` from it;
// `convex/desired.test.ts` checks that the builder still produces those exact
// bytes; the Rust agent verifies the same files (Step 9). Every id is a fixed,
// obviously fake string. Changing anything here changes the vectors: run
// `node scripts/gen-policy-vectors.mjs` and commit both.

import type { BuildInput } from "../../convex/lib/desired";
import { DEFAULT_WEB_PERMISSIONS } from "../../convex/lib/validators";

/**
 * Argon2id PHC of the TEST exit PIN "246813" with the fixed 16-byte salt
 * "rulebox-vector-1" and the agent's parameters (m=19456, t=2, p=1, 32 bytes).
 * The generator recomputes and checks it.
 */
export const VECTOR_PIN = "246813";
export const VECTOR_PIN_SALT = "rulebox-vector-1";
export const VECTOR_PIN_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$cnVsZWJveC12ZWN0b3ItMQ$bsRu3JR6kqceQgUhW6gLhsNaDytRywphbIf52wZ6/zg";

export const VECTOR_IDS = {
  orgId: "org_test_vector_1",
  deviceId: "dev_test_vector_1",
  groupId: "grp_test_vector_1",
  webAppId: "app_test_web_1",
  desktopAppId: "app_test_desktop_1",
  employeeId: "emp_test_vector_1",
  employee2Id: "emp_test_vector_2",
} as const;

export const VECTOR_VERSION = 7;
export const VECTOR_ISSUED_AT_MS = 1760950000000;

/** Two apps (one web for everyone, one desktop for a selected employee), one employee, a PIN, a file rule. */
export const VECTOR_INPUT: BuildInput = {
  org: { _id: VECTOR_IDS.orgId, name: "Acme Test" },
  settings: {
    offlineDays: 3,
    defaultQuotaGb: 10,
    power: { sleep: true, restart: true, shutDown: false },
    adminExit: { enabled: true, hotkey: "Ctrl+Shift+F12" },
  },
  pinHash: VECTOR_PIN_HASH,
  group: { _id: VECTOR_IDS.groupId },
  assignments: [
    { appId: VECTOR_IDS.webAppId, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: true },
    { appId: VECTOR_IDS.desktopAppId, audience: "selected", pinnedTaskbar: false, pinnedDesktop: true },
  ],
  apps: [
    {
      _id: VECTOR_IDS.webAppId,
      name: "Orders",
      description: "Order desk",
      kind: "web",
      hue: 175,
      archived: false,
      revision: 2,
      web: {
        url: "https://orders.example.test/",
        allowedDomains: ["orders.example.test"],
        permissions: { ...DEFAULT_WEB_PERMISSIONS, printing: true },
      },
    },
    {
      _id: VECTOR_IDS.desktopAppId,
      name: "Writer",
      kind: "desktop",
      archived: false,
      revision: 1,
      desktop: {
        exe: "{ProgramFiles}\\Writer\\writer.exe",
        args: [],
        fileArgTemplate: ["{file}"],
        install: {
          kind: "msi",
          url: "https://downloads.example.test/writer-1.0.msi",
          sha256: "0000000000000000000000000000000000000000000000000000000000000001",
          sizeBytes: 1048576,
          silentArgs: [],
          productCode: "{00000000-0000-0000-0000-000000000001}",
          successExitCodes: [0],
          removeWhenUnassigned: true,
        },
        resetFolders: ["{RoamingAppData}\\Writer"],
      },
    },
  ],
  employees: [{ _id: VECTOR_IDS.employeeId, disabled: false }],
  employeeApps: [{ employeeId: VECTOR_IDS.employeeId, appId: VECTOR_IDS.desktopAppId }],
  fileHandlers: [{ extension: ".docx", appId: VECTOR_IDS.desktopAppId }],
  device: { _id: VECTOR_IDS.deviceId, kioskEnabled: true },
};

/** The roster vector (A6): two members added, one removed, then a snapshot of what is left. */
export const ROSTER_VECTOR_CHANGES: { employeeId: string; credentialRevision: number | null }[] = [
  { employeeId: VECTOR_IDS.employeeId, credentialRevision: 3 },
  { employeeId: VECTOR_IDS.employee2Id, credentialRevision: 1 },
  { employeeId: VECTOR_IDS.employee2Id, credentialRevision: null },
];
