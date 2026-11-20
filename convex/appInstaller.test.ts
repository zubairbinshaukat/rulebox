import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { FIXTURES } from "../tests/convex/installerFixtures";
import { rangeHost } from "../tests/convex/rangeHost";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { silentArgTokenProblem } from "./lib/appRules";

// Phase 6 Step 13 (plan 4.2, 4.6, 4.7): the installer details of an app (`tech`, `answerFile`, `timeoutMin`, `publisher`, editable
// `successExitCodes`), their pass-through into the signed document, and `apps:inspectInstaller`. No test touches the network.

beforeEach(() => {
  auditPolicy.strict = true;
});
afterEach(() => {
  auditPolicy.strict = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function admin(t: T, orgId: Id<"organizations">) {
  const m = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, m);
  return m;
}
async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  return { t, orgId, a: await admin(t, orgId) };
}

type Over = Record<string, unknown>;
const SHA = "ab".repeat(32);
const ANSWER = { url: "https://downloads.example.com/setup.iss", sha256: "cd".repeat(32), sizeBytes: 2048 };
const exeInstall = (over: Over = {}) => ({ kind: "exe" as const, url: "https://downloads.example.com/setup.exe", sha256: SHA, sizeBytes: 5000, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false, ...over });
const program = (install: Over = {}, over: Over = {}) => ({
  name: "Acme",
  desktop: { source: "exe" as const, exe: "{ProgramFiles}\\Acme\\acme.exe", args: [], fileArgTemplate: [], resetFolders: [], install: exeInstall(install), ...over },
});

async function refusal(p: Promise<unknown>): Promise<{ code: string; field?: string; detail?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { data: { code: string; field?: string; detail?: string } }).data;
  }
}
const installOf = async (t: T, id: Id<"apps">) => (await t.run((ctx) => ctx.db.get(id)))?.desktop?.install;

describe("installer details: what is stored", () => {
  test("a wizard installer keeps its technology, answer file, timeout, expected signer and success codes (sorted, 0 first)", async () => {
    const { t, a } = await setup();
    const id = await a.as.mutation(
      api.apps.createDesktop,
      program({ tech: "installshield_script", silentArgs: ["/s", "/f1{AnswerFile}", "/f2{LogFile}"], answerFile: { ...ANSWER, url: ` ${ANSWER.url} `, sha256: ANSWER.sha256.toUpperCase() }, timeoutMin: 45, publisher: "  Acme Software Ltd ", successExitCodes: [3010, 1641, 0, 3010] }),
    );
    expect(await installOf(t, id)).toEqual({
      kind: "exe",
      url: "https://downloads.example.com/setup.exe",
      sha256: SHA,
      sizeBytes: 5000,
      silentArgs: ["/s", "/f1{AnswerFile}", "/f2{LogFile}"],
      successExitCodes: [0, 1641, 3010],
      removeWhenUnassigned: false,
      tech: "installshield_script",
      answerFile: ANSWER,
      timeoutMin: 45,
      publisher: "Acme Software Ltd",
    });
  });

  test("plain EXE and MSI technologies are the same as none; old rows without the fields stay as they are", async () => {
    const { t, a } = await setup();
    const exe = await a.as.mutation(api.apps.createDesktop, program({ tech: "exe" }));
    expect(await installOf(t, exe)).not.toHaveProperty("tech");
    const msi = await a.as.mutation(api.apps.createDesktop, { name: "M", desktop: { ...program().desktop, source: "msi", install: exeInstall({ kind: "msi", silentArgs: [], tech: "msi", removeWhenUnassigned: true }) } });
    expect(await installOf(t, msi)).not.toHaveProperty("tech");
    const plain = await a.as.mutation(api.apps.createDesktop, program());
    const row = await installOf(t, plain);
    for (const key of ["tech", "answerFile", "timeoutMin", "publisher"]) expect(row, key).not.toHaveProperty(key);
  });

  test("saving the same details again changes nothing (no new revision)", async () => {
    const { t, a } = await setup();
    const input = program({ tech: "inno", silentArgs: ["/VERYSILENT"], timeoutMin: 20 });
    const id = await a.as.mutation(api.apps.createDesktop, input);
    const rev = (await t.run((ctx) => ctx.db.get(id)))!.revision;
    expect(await a.as.mutation(api.apps.update, { appId: id, expectedRevision: rev, desktop: input })).toEqual({ revision: rev });
    expect(await a.as.mutation(api.apps.update, { appId: id, expectedRevision: rev, desktop: program({ tech: "inno", silentArgs: ["/VERYSILENT"], timeoutMin: 21 }) })).toEqual({ revision: rev + 1 });
  });
});

describe("installer details: the refusals", () => {
  test("tech has to fit the kind", async () => {
    const { a } = await setup();
    const make = (over: Over, source: "exe" | "msi" | "portable" = "exe") =>
      refusal(a.as.mutation(api.apps.createDesktop, { name: "X", desktop: { ...program().desktop, source, exe: source === "portable" ? "{RuleboxApps}\\{AppId}\\x.exe" : "{ProgramFiles}\\X\\x.exe", install: exeInstall({ kind: source, ...(source === "msi" ? { silentArgs: [] } : {}), ...over }) } }));
    expect(await make({ tech: "msi" })).toMatchObject({ code: "invalid_argument", field: "install.tech" });
    expect(await make({ tech: "nsis" }, "msi")).toMatchObject({ field: "install.tech" });
    expect(await make({ tech: "nsis" }, "portable")).toMatchObject({ field: "install.tech" });
    await expect(a.as.mutation(api.apps.createDesktop, program({ tech: "unknown" }))).rejects.toThrow(); // not a value of the validator at all
    expect(await make({ tech: "burn", silentArgs: ["/quiet"] })).toBeNull();
  });

  test("timeout: whole minutes 5 to 120, not for a portable file", async () => {
    const { a } = await setup();
    const make = (timeoutMin: number) => refusal(a.as.mutation(api.apps.createDesktop, program({ timeoutMin })));
    for (const bad of [4, 121, 0, -5, 30.5, Number.NaN]) expect(await make(bad), String(bad)).toMatchObject({ field: "install.timeoutMin" });
    expect(await make(5)).toBeNull();
    expect(await make(120)).toBeNull();
    const portable = refusal(a.as.mutation(api.apps.createDesktop, { name: "P", desktop: { ...program().desktop, source: "portable", exe: "{RuleboxApps}\\{AppId}\\p.exe", install: exeInstall({ kind: "portable", silentArgs: [], timeoutMin: 30 }) } }));
    expect(await portable).toMatchObject({ field: "install.timeoutMin" });
  });

  test("answer file: an EXE, https, .iss, a 64-hex hash, at most 256 KiB, and {AnswerFile} in the switches", async () => {
    const { a } = await setup();
    const make = (answerFile: Over, silentArgs: string[] = ["/s", "/f1{AnswerFile}"]) => refusal(a.as.mutation(api.apps.createDesktop, program({ silentArgs, answerFile: { ...ANSWER, ...answerFile } })));
    expect(await make({})).toBeNull();
    expect(await make({ url: "http://downloads.example.com/a.iss" })).toMatchObject({ field: "install.answerFile.url" });
    expect(await make({ url: "https://downloads.example.com/a.txt" })).toMatchObject({ field: "install.answerFile.url", detail: "answer_file_not_iss" });
    expect(await make({ url: "https://downloads.example.com/a.iss?x=1" })).toBeNull(); // judged by the path
    expect(await make({ url: "https://downloads.example.com/dl?file=a.iss" })).toMatchObject({ detail: "answer_file_not_iss" });
    expect(await make({ sha256: "xyz" })).toMatchObject({ field: "install.answerFile.sha256" });
    expect(await make({ sizeBytes: 256 * 1024 })).toBeNull();
    expect(await make({ sizeBytes: 256 * 1024 + 1 })).toMatchObject({ field: "install.answerFile.sizeBytes" });
    expect(await make({ sizeBytes: -1 })).toMatchObject({ field: "install.answerFile.sizeBytes" });
    expect(await make({}, ["/s"])).toMatchObject({ field: "install.answerFile", detail: "answer_file_unused" });
    // The token without a file would reach the installer as text.
    expect(await refusal(a.as.mutation(api.apps.createDesktop, program({ silentArgs: ["/s", "/f1{AnswerFile}"] })))).toMatchObject({ field: "install.silentArgs", detail: "answer_file_missing" });
    const msi = refusal(a.as.mutation(api.apps.createDesktop, { name: "M", desktop: { ...program().desktop, source: "msi", install: exeInstall({ kind: "msi", silentArgs: [], answerFile: ANSWER }) } }));
    expect(await msi).toMatchObject({ field: "install.answerFile" });
  });

  test("a token in the wrong place is refused: only {AnswerFile} and {LogFile}, whole", async () => {
    expect(silentArgTokenProblem(["/s", "/f1{AnswerFile}", "/f2{LogFile}", "{AnswerFile}{LogFile}"])).toBe(false);
    for (const bad of ["{file}", "{answerfile}", "{AnswerFile", "AnswerFile}", "{", "}", "/x{Foo}", "{{AnswerFile}}", "{AnswerFile}}", "%TEMP%{LogFile}{x}"]) {
      expect(silentArgTokenProblem([bad]), bad).toBe(true);
    }
    const { a } = await setup();
    expect(await refusal(a.as.mutation(api.apps.createDesktop, program({ silentArgs: ["/D={x}"] })))).toMatchObject({ field: "install.silentArgs", detail: "silent_arg_token" });
    expect(await refusal(a.as.mutation(api.apps.createDesktop, program({ silentArgs: ["/L={LogFile}"] })))).toBeNull();
  });

  test("expected signer: text of at most 200 characters without control characters; success codes: integers, at most 16", async () => {
    const { a } = await setup();
    const make = (over: Over) => refusal(a.as.mutation(api.apps.createDesktop, program(over)));
    expect(await make({ publisher: "x".repeat(201) })).toMatchObject({ field: "install.publisher" });
    expect(await make({ publisher: "Acme\u0007" })).toMatchObject({ field: "install.publisher" });
    expect(await make({ publisher: "   " })).toBeNull();
    expect(await make({ successExitCodes: [0, 3010.5] })).toMatchObject({ field: "install.successExitCodes" });
    expect(await make({ successExitCodes: Array.from({ length: 17 }, (_, i) => i + 1) })).toMatchObject({ field: "install.successExitCodes" });
  });
});

describe("installer details: the signed document", () => {
  test("a device gets tech, answerFile, timeoutMin and publisher in the order of the Rust struct; an app without them has none of the keys", async () => {
    vi.useFakeTimers();
    const { t, orgId, a } = await setup();
    const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Front", revision: 0, createdAt: Date.now() }));
    const { deviceId } = await enrollDevice(t, orgId, { groupId });
    await drain();
    const wizard = await a.as.mutation(
      api.apps.createDesktop,
      program({ tech: "installshield_script", silentArgs: ["/s", "/f1{AnswerFile}"], answerFile: ANSWER, timeoutMin: 60, publisher: "Acme Software Ltd", successExitCodes: [0, 3010] }),
    );
    const plain = await a.as.mutation(api.apps.createDesktop, { ...program(), name: "Plain", desktop: { ...program().desktop, exe: "{ProgramFiles}\\Plain\\p.exe" } });
    for (const appId of [wizard, plain]) await a.as.mutation(api.groups.assignApp, { groupId, appId, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });
    await drain();

    const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
    const body = await t.run((ctx) => ctx.db.get(head!.bodyId));
    const doc = (JSON.parse(body!.payload) as { doc: { catalog: { id: string; desktop: { install: Record<string, unknown> } | null }[] } }).doc;
    const wizardInstall = doc.catalog.find((c) => c.id === wizard)!.desktop!.install;
    expect(Object.keys(wizardInstall)).toEqual(["kind", "url", "sha256", "sizeBytes", "silentArgs", "productCode", "successExitCodes", "removeWhenUnassigned", "tech", "answerFile", "timeoutMin", "publisher"]);
    expect(wizardInstall).toMatchObject({ tech: "installshield_script", answerFile: ANSWER, timeoutMin: 60, publisher: "Acme Software Ltd", successExitCodes: [0, 3010] });
    expect(Object.keys(wizardInstall.answerFile as object)).toEqual(["url", "sha256", "sizeBytes"]);
    const plainInstall = doc.catalog.find((c) => c.id === plain)!.desktop!.install;
    expect(Object.keys(plainInstall)).toEqual(["kind", "url", "sha256", "sizeBytes", "silentArgs", "productCode", "successExitCodes", "removeWhenUnassigned"]);
  });
});

describe("apps:inspectInstaller", () => {
  const URL1 = "https://downloads.example.com/setup.exe";

  test("answers the technology, the pre-filled switches and codes, and the details; stores nothing", async () => {
    const { t, a } = await setup();
    const host = rangeHost({ [URL1]: { body: FIXTURES.nsisHigh() } });
    vi.stubGlobal("fetch", host.fetch);
    const r = await a.as.action(api.apps.inspectInstaller, { url: ` ${URL1} ` });
    expect(r).toMatchObject({ tech: "nsis", kind: "exe", confidence: "high", silentArgs: ["/S"], successExitCodes: [0], needsAnswerFile: false, perUserLikely: true, fileVersion: "1.2.3.4", productName: "Fixture App", sizeBytes: FIXTURES.nsisHigh().length });
    expect(host.calls).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("apps").take(1))).toEqual([]);
    expect(await t.run((ctx) => ctx.db.system.query("_storage").take(1))).toEqual([]);
  });

  test("InstallScript says it needs an answer file", async () => {
    const { a } = await setup();
    vi.stubGlobal("fetch", rangeHost({ [URL1]: { body: FIXTURES.installshieldScript() } }).fetch);
    expect(await a.as.action(api.apps.inspectInstaller, { url: URL1 })).toMatchObject({ tech: "installshield_script", silentArgs: ["/s", "/f1{AnswerFile}"], needsAnswerFile: true });
  });

  test("refusals name the field and the reason: a bad address is refused before any request", async () => {
    const { a } = await setup();
    const host = rangeHost({
      [URL1]: { body: FIXTURES.nsisHigh(), ranges: false, declaredLength: 500 * 1024 * 1024 },
      "https://downloads.example.com/page": { body: new TextEncoder().encode("<html></html>") },
      "https://downloads.example.com/to-private": { body: new Uint8Array(0), redirect: "https://10.0.0.1/a.exe" },
    });
    vi.stubGlobal("fetch", host.fetch);
    for (const url of ["http://downloads.example.com/a.exe", "nonsense", ""]) {
      expect(await refusal(a.as.action(api.apps.inspectInstaller, { url })), url).toMatchObject({ code: "invalid_argument", field: "url" });
    }
    expect(host.calls).toEqual([]);
    expect(await refusal(a.as.action(api.apps.inspectInstaller, { url: URL1 }))).toMatchObject({ code: "invalid_argument", field: "url", detail: "inspect_unsupported" });
    expect(await refusal(a.as.action(api.apps.inspectInstaller, { url: "https://downloads.example.com/page" }))).toMatchObject({ detail: "inspect_not_installer" });
    expect(await refusal(a.as.action(api.apps.inspectInstaller, { url: "https://downloads.example.com/to-private" }))).toMatchObject({ detail: "inspect_blocked" });
    expect(await refusal(a.as.action(api.apps.inspectInstaller, { url: "https://downloads.example.com/missing" }))).toMatchObject({ detail: "inspect_failed" });
    expect(host.calls.map((c) => c.url)).not.toContain("https://10.0.0.1/a.exe");
  });

  test("a viewer cannot use it; 30 an hour per organization, and another organization has its own", async () => {
    const t = await setupAuth();
    const orgA = await makeOrg(t, "A");
    const orgB = await makeOrg(t, "B");
    const viewer = await asMember(t, { role: "viewer", orgId: orgA });
    vi.stubGlobal("fetch", rangeHost({ [URL1]: { body: FIXTURES.msi() } }).fetch);
    await expectCode(viewer.as.action(api.apps.inspectInstaller, { url: URL1 }), "forbidden");
    const a = await admin(t, orgA);
    for (let i = 0; i < 30; i++) await a.as.action(api.apps.inspectInstaller, { url: URL1 });
    await expectCode(a.as.action(api.apps.inspectInstaller, { url: URL1 }), "rate_limited");
    const b = await admin(t, orgB);
    expect(await b.as.action(api.apps.inspectInstaller, { url: URL1 })).toMatchObject({ tech: "msi" });
  });
});
