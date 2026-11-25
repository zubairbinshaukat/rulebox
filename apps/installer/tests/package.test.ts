// Static checks of the MSI sources (plan Phase 6 Step 7). No WiX, no .NET, no network:
// the .wxs files are read as text, parsed with a tiny XML reader, and compared with the Rust
// sources that read the same names (service.rs, guard.rs, security.rs).
//
// What this cannot show: that WiX accepts the files or that Windows Installer behaves as
// written. That needs a real build and the VM run (plan Step 22).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const installerDir = join(here, "..");
const repoRoot = join(here, "..", "..", "..");

const WXS_FILES = ["Package.wxs", "Service.wxs", "StaffApp.wxs", "Checks.wxs", "UI.wxs"] as const;

// ---- a minimal XML reader (comments and the prolog are dropped) -----------------------------

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseXml(source: string): El {
  const src = source.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  const root: El = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: El[] = [root];
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  let index = 0;
  while (index < src.length) {
    token.lastIndex = index;
    const match = token.exec(src);
    if (!match) throw new Error(`not well-formed XML near: ${src.slice(index, index + 60)}`);
    index = token.lastIndex;
    const [, closing, name, attributeText, selfClosing, text] = match;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      top.text += decode(text);
    } else if (closing) {
      if (top.name !== name) throw new Error(`</${name}> closes <${top.name}>`);
      stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const pair of attributeText.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[pair[1]] = decode(pair[2] ?? pair[3]);
      }
      const element: El = { name, attrs, children: [], text: "" };
      top.children.push(element);
      if (!selfClosing) stack.push(element);
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is never closed`);
  return root;
}

function descendants(el: El, name?: string): El[] {
  const found: El[] = [];
  for (const child of el.children) {
    if (name === undefined || child.name === name) found.push(child);
    found.push(...descendants(child, name));
  }
  return found;
}

// ---- the sources -----------------------------------------------------------------------------

const raw: Record<string, string> = {};
const docs: Record<string, El> = {};
for (const file of WXS_FILES) {
  raw[file] = readFileSync(join(installerDir, file), "utf8");
  docs[file] = parseXml(raw[file]);
}
const everything = { name: "#all", attrs: {}, text: "", children: WXS_FILES.map((file) => docs[file]) } satisfies El;
const all = (name: string): El[] => descendants(everything, name);
const one = (name: string): El => {
  const found = all(name);
  expect(found, `exactly one <${name}>`).toHaveLength(1);
  return found[0];
};

function rustConst(file: string, name: string): string {
  const source = readFileSync(join(repoRoot, file), "utf8");
  const match = new RegExp(`const ${name}: &str\\s*=\\s*r?#*"([^"]*)"`).exec(source);
  if (!match) throw new Error(`const ${name} not found in ${file}`);
  return match[1];
}

const AGENT_SERVICE_RS = "apps/agent/src/service.rs";
const GUARD_RS = "crates/rulebox-win32/src/guard.rs";
const SECURITY_RS = "crates/rulebox-win32/src/security.rs";

// ---- tests -----------------------------------------------------------------------------------

describe("package", () => {
  test("every .wxs file is well-formed WiX v4+ XML", () => {
    for (const file of WXS_FILES) {
      expect(docs[file].children, file).toHaveLength(1);
      expect(docs[file].children[0].name, file).toBe("Wix");
      expect(docs[file].children[0].attrs.xmlns, file).toBe("http://wixtoolset.org/schemas/v4/wxs");
    }
  });

  test("the upgrade code never changes", () => {
    expect(one("Package").attrs.UpgradeCode).toBe("76E0E816-6BEE-40CB-8BA0-6B32C8A1EB56");
  });

  test("the package is per machine, takes its version from the build and is x64-only by the build flag", () => {
    const pkg = one("Package");
    expect(pkg.attrs.Scope).toBe("perMachine");
    expect(pkg.attrs.Version).toBe("$(Version)");
    expect(Number(pkg.attrs.InstallerVersion)).toBeGreaterThanOrEqual(500);
    const build = readFileSync(join(installerDir, "build.ps1"), "utf8");
    expect(build).toContain("'-arch', 'x64'");
  });

  test("a major upgrade removes the old version after install initialize, with a downgrade message", () => {
    const upgrade = one("MajorUpgrade");
    expect(upgrade.attrs.Schedule).toBe("afterInstallInitialize");
    expect(upgrade.attrs.DowngradeErrorMessage).toMatch(/newer version of Rulebox/);
  });

  test("the folder, the dialogs and the checks are all linked from Package.wxs", () => {
    const defined = (name: string, from: string[]) =>
      new Set(from.flatMap((file) => descendants(docs[file], name).map((el) => el.attrs.Id)));
    for (const ref of descendants(docs["Package.wxs"], "ComponentGroupRef")) {
      expect(defined("ComponentGroup", [...WXS_FILES]).has(ref.attrs.Id), ref.attrs.Id).toBe(true);
    }
    expect(defined("UI", [...WXS_FILES]).has(one("UIRef").attrs.Id)).toBe(true);
    expect(defined("Property", [...WXS_FILES]).has(one("PropertyRef").attrs.Id)).toBe(true);
  });

  test("component, file and registry ids are unique across the files", () => {
    for (const name of ["Component", "File", "RegistryValue", "ComponentGroup", "Directory", "Property"]) {
      const ids = all(name)
        .map((el) => el.attrs.Id)
        .filter((id): id is string => id !== undefined);
      expect(new Set(ids).size, `duplicate ${name} Id: ${ids.join(", ")}`).toBe(ids.length);
    }
  });
});

describe("no script and no EXE custom action", () => {
  test("the only custom action is the WiX Util ShellExec DLL entry on the Setup shortcut", () => {
    const action = one("CustomAction");
    expect(action.attrs.Id).toBe("LaunchRuleboxSetup");
    expect(action.attrs.DllEntry).toBe("WixShellExec");
    expect(action.attrs.BinaryRef).toBe("Wix4UtilCA_X64");
    for (const forbidden of ["ExeCommand", "Script", "JScriptCall", "VBScriptCall", "FileRef", "Directory", "Property", "Value"]) {
      expect(action.attrs[forbidden], forbidden).toBeUndefined();
    }
    expect(all("Binary")).toHaveLength(0);
    expect(all("CustomActionRef")).toHaveLength(0);
  });

  test("it is started from the finish page only, never in a sequence, and not on uninstall", () => {
    const publishes = all("Publish");
    for (const publish of publishes) {
      expect(publish.attrs.Dialog).toBe("ExitDialog");
      expect(publish.attrs.Control).toBe("Finish");
      expect(publish.attrs.Condition).toContain("NOT Installed");
    }
    const launch = publishes.filter((el) => el.attrs.Event === "DoAction");
    expect(launch).toHaveLength(1);
    expect(launch[0].attrs.Value).toBe("LaunchRuleboxSetup");
    for (const sequence of ["InstallExecuteSequence", "InstallUISequence"]) {
      for (const el of all(sequence)) {
        expect(el.children.filter((child) => child.name === "Custom")).toHaveLength(0);
      }
    }
  });

  test("the finish page opens the Rulebox Setup shortcut", () => {
    // Set by the Finish button (a Publish value is formatted; a Property value is not),
    // before the launch action runs.
    expect(all("Property").find((el) => el.attrs.Id === "WixShellExecTarget")).toBeUndefined();
    const publishes = all("Publish");
    const target = publishes.find((el) => el.attrs.Property === "WixShellExecTarget");
    expect(target?.attrs.Value).toBe("[RuleboxMenuFolder]Rulebox Setup.lnk");
    const launch = publishes.find((el) => el.attrs.Event === "DoAction");
    expect(Number(target?.attrs.Order)).toBeLessThan(Number(launch?.attrs.Order));
    expect(one("Shortcut").attrs.Name).toBe("Rulebox Setup");
    expect(one("Shortcut").attrs.Arguments).toBe("setup");
  });

  test("the dialog set is WixUI_Minimal with a licence file that exists", () => {
    expect(one("ui:WixUI").attrs.Id).toBe("WixUI_Minimal");
    const variable = all("WixVariable").find((el) => el.attrs.Id === "WixUILicenseRtf");
    expect(variable?.attrs.Value).toBe("$(InstallerDir)\\License.rtf");
    expect(readFileSync(join(installerDir, "License.rtf"), "utf8").startsWith("{\\rtf1")).toBe(true);
  });

  test("no VBScript or JScript appears anywhere in the installer folder", () => {
    for (const file of WXS_FILES) expect(raw[file], file).not.toMatch(/vbscript|jscript|\.vbs\b|\.js\b|ExeCommand/i);
    expect(existsSync(join(installerDir, "scripts"))).toBe(false);
  });
});

describe("service", () => {
  const install = () => one("ServiceInstall");

  test("name, display name and arguments are the ones the agent installs itself with", () => {
    const serviceRs = readFileSync(join(repoRoot, AGENT_SERVICE_RS), "utf8");
    expect(install().attrs.Name).toBe(rustConst(AGENT_SERVICE_RS, "SERVICE_NAME"));
    expect(install().attrs.Name).toBe(rustConst("crates/rulebox-win32/src/service.rs", "AGENT_SERVICE"));
    expect(install().attrs.DisplayName).toBe(rustConst(AGENT_SERVICE_RS, "DISPLAY_NAME"));
    expect(install().attrs.Description).toBe(rustConst(AGENT_SERVICE_RS, "DESCRIPTION"));
    const args = /launch_arguments:\s*vec!\[([^\]]*)\]/.exec(serviceRs)?.[1];
    const fromRust = [...(args ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1]).join(" ");
    expect(fromRust).toBe("service run");
    expect(install().attrs.Arguments).toBe(fromRust);
  });

  test("own process, automatic start, normal error control, vital, LocalSystem", () => {
    const attrs = install().attrs;
    expect(attrs.Type).toBe("ownProcess");
    expect(attrs.Start).toBe("auto");
    expect(attrs.ErrorControl).toBe("normal");
    expect(attrs.Vital).toBe("yes");
    expect(attrs.Account).toBeUndefined();
    expect(attrs.Password).toBeUndefined();
  });

  test("ServiceConfig is nested directly under ServiceInstall: restart x3 after 5 s, reset after 1 day", () => {
    const configs = all("util:ServiceConfig");
    expect(configs).toHaveLength(1);
    expect(install().children).toContain(configs[0]);
    expect(configs[0].attrs).toMatchObject({
      FirstFailureActionType: "restart",
      SecondFailureActionType: "restart",
      ThirdFailureActionType: "restart",
      RestartServiceDelayInSeconds: "5",
      ResetPeriodInDays: "1",
    });
  });

  test("the service control starts it at install, stops it on install and uninstall, removes it at uninstall", () => {
    const control = one("ServiceControl");
    expect(control.attrs).toMatchObject({ Name: install().attrs.Name, Start: "install", Stop: "both", Remove: "uninstall" });
  });

  test("the service binary is the key path of its component, as rulebox-agent.exe", () => {
    const component = all("Component").find((el) => el.children.includes(install()));
    const file = component?.children.find((el) => el.name === "File");
    expect(file?.attrs).toMatchObject({ Id: "RuleboxAgentExe", Name: "rulebox-agent.exe", KeyPath: "yes" });
  });
});

describe("launch conditions", () => {
  const conditions = () => all("Launch").map((el) => el.attrs);
  const find = (needle: string) => {
    const found = conditions().filter((attrs) => attrs.Condition.includes(needle));
    expect(found, needle).toHaveLength(1);
    return found[0];
  };

  test("administrator, x64, build 19045 and 2 GiB free, each with its own message", () => {
    expect(find("Privileged").Condition).toBe("Installed OR Privileged");
    expect(find("VersionNT64").Condition).toBe("Installed OR VersionNT64");
    expect(find("WINBUILD").Condition).toBe("Installed OR WINBUILD >= 19045");
    expect(find("PrimaryVolumeSpaceAvailable").Condition).toBe("Installed OR PrimaryVolumeSpaceAvailable >= 2097152");
    const messages = conditions().map((attrs) => attrs.Message);
    expect(messages.every((message) => message && message.length > 20)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length);
  });

  test("the build number is read from the registry (VersionNT stops at 8.1 values)", () => {
    const search = all("RegistrySearch").find((el) => el.attrs.Id === "WinBuildSearch")!;
    const property = all("Property").find((el) => el.children.includes(search));
    expect(property?.attrs.Id).toBe("WINBUILD");
    expect(search.attrs).toMatchObject({
      Root: "HKLM",
      Key: "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
      Name: "CurrentBuildNumber",
      Type: "raw",
      Bitness: "always64",
    });
  });

  test("the uninstall guard blocks removal while the kiosk is on, except in a major upgrade", () => {
    const guard = find("KIOSKON");
    expect(guard.Condition).toBe(
      'NOT (Installed AND REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND (KIOSKON="1" OR KIOSKON="#1"))',
    );
    expect(guard.Message).toMatch(/Turn kiosk mode off first/);
    const search = all("RegistrySearch").find((el) => el.attrs.Id === "KioskOnSearch");
    expect(search?.attrs).toMatchObject({ Root: "HKLM", Key: rustConst(GUARD_RS, "INSTALL_KEY"), Name: "KioskOn", Bitness: "always64" });
  });

  test("LaunchConditions is moved after CostFinalize in both sequences (disk space needs costing)", () => {
    for (const sequence of ["InstallUISequence", "InstallExecuteSequence"]) {
      const action = one(sequence).children.find((el) => el.name === "LaunchConditions");
      expect(action?.attrs.After, sequence).toBe("CostFinalize");
    }
  });
});

describe("files and registry", () => {
  const files = () => all("File").map((el) => ({ id: el.attrs.Id, name: el.attrs.Name, source: el.attrs.Source }));

  test("the PRD 23.3 layout is complete: agent, launcher, current.json, versions\\<version>\\Staff App", () => {
    const byName = new Map(files().map((file) => [file.name, file.source]));
    expect(byName.get("rulebox-agent.exe")).toBe("$(BinDir)\\rulebox-agent.exe");
    expect(byName.get("rulebox-shell.exe")).toBe("$(BinDir)\\rulebox-shell.exe");
    expect(byName.get("current.json")).toBe("$(StageDir)\\current.json");
    expect(byName.get("rulebox-staff.exe")).toBe("$(BinDir)\\rulebox-staff.exe");
    expect(byName.get("MicrosoftEdgeWebview2Setup.exe")).toBe("$(StageDir)\\MicrosoftEdgeWebview2Setup.exe");
    expect(byName.get("THIRD_PARTY_NOTICES.md")).toBe("$(RepoRoot)\\THIRD_PARTY_NOTICES.md");
    expect(byName.get("LICENSE")).toBe("$(RepoRoot)\\LICENSE");
    expect(existsSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "LICENSE"))).toBe(true);
  });

  test("the Staff App sits in versions\\<Version>, and current.json names that same path", () => {
    const staff = all("Component").find((el) => el.attrs.Id === "StaffAppExecutable");
    expect(staff?.attrs.Directory).toBe("CurrentVersionFolder");
    const versions = all("Directory").find((el) => el.attrs.Id === "VersionsFolder");
    expect(versions?.attrs.Name).toBe("versions");
    expect(versions?.children[0].attrs).toMatchObject({ Id: "CurrentVersionFolder", Name: "$(Version)" });
    const build = readFileSync(join(installerDir, "build.ps1"), "utf8");
    expect(build).toContain('"exe":"versions\\\\{0}\\\\rulebox-staff.exe"');
  });

  test("every $(Variable) the sources use is defined by build.ps1", () => {
    const build = readFileSync(join(installerDir, "build.ps1"), "utf8");
    const used = new Set(WXS_FILES.flatMap((file) => [...raw[file].matchAll(/\$\((\w+)\)/g)].map((match) => match[1])));
    expect([...used].sort()).toEqual(["BinDir", "InstallerDir", "RepoRoot", "StageDir", "Version"]);
    for (const name of used) expect(build, name).toContain(`"${name}=$`);
  });

  test("the install marker is the key and value the production guard reads, and the MSI never writes ComputerName", () => {
    const marker = all("RegistryKey").find((el) => el.attrs.Key === rustConst(GUARD_RS, "INSTALL_KEY"));
    expect(marker).toBeDefined();
    expect(marker?.attrs.Root).toBe("HKLM");
    expect(marker?.attrs.ForceDeleteOnUninstall).toBe("yes");
    const values = marker!.children.filter((el) => el.name === "RegistryValue");
    expect(values.map((el) => el.attrs.Name).sort()).toEqual([rustConst(GUARD_RS, "INSTALL_DIR_VALUE"), "Version"].sort());
    expect(values.find((el) => el.attrs.Name === "InstallDir")?.attrs.Value).toBe("[INSTALLFOLDER]");
    expect(all("RegistryValue").some((el) => el.attrs.Name === rustConst(GUARD_RS, "INSTALL_COMPUTER_VALUE"))).toBe(false);
    const component = all("Component").find((el) => el.children.includes(marker!));
    expect(component?.attrs.Bitness).toBe("always64");
  });

  test("the install folder ACL is the SDDL the guard compares against", () => {
    const sddl = all("PermissionEx").map((el) => el.attrs.Sddl);
    expect(sddl).toContain(rustConst(SECURITY_RS, "INSTALL_DIR_SDDL"));
    const folderAcl = all("Component").find((el) => el.attrs.Id === "InstallFolderAcl");
    expect(folderAcl?.children[0].name).toBe("CreateFolder");
    expect(folderAcl?.children[0].children[0].attrs.Sddl).toBe(rustConst(SECURITY_RS, "INSTALL_DIR_SDDL"));
  });
});

describe("silent enrollment", () => {
  test("ENROLLCODE is hidden (kept out of logs) and secure (reaches the elevated install)", () => {
    const property = all("Property").find((el) => el.attrs.Id === "ENROLLCODE");
    expect(property?.attrs).toMatchObject({ Hidden: "yes", Secure: "yes" });
    expect(property?.attrs.Value).toBeUndefined();
  });

  test("the code is written to Install\\Pending, only when set, readable by SYSTEM and Administrators only", () => {
    const component = all("Component").find((el) => el.attrs.Id === "PendingEnrollment");
    expect(component?.attrs.Condition).toBe("ENROLLCODE");
    const key = component?.children.find((el) => el.name === "RegistryKey");
    // WiX v4+ applies PermissionEx on a RegistryKey only with ForceCreateOnInstall.
    expect(key?.attrs.ForceCreateOnInstall).toBe("yes");
    expect(key?.attrs.Key).toBe(`${rustConst(GUARD_RS, "INSTALL_KEY")}\\Pending`);
    expect(key?.attrs.Root).toBe("HKLM");
    const value = key?.children.find((el) => el.name === "RegistryValue");
    expect(value?.attrs).toMatchObject({ Name: "Code", Value: "[ENROLLCODE]" });
    const sddl = key?.children.find((el) => el.name === "PermissionEx")?.attrs.Sddl ?? "";
    expect(sddl.startsWith("D:P")).toBe(true);
    expect(sddl).toMatch(/;;;SY\)/);
    expect(sddl).toMatch(/;;;BA\)/);
    expect(sddl).not.toMatch(/;;;(BU|WD|AU|IU)\)/);
  });

  test("the code appears only in that one registry value", () => {
    for (const file of WXS_FILES) {
      const hits = raw[file].match(/\[ENROLLCODE\]/g) ?? [];
      expect(hits.length, file).toBe(file === "Package.wxs" ? 1 : 0);
    }
  });
});

describe("build script and Tauri", () => {
  const build = readFileSync(join(installerDir, "build.ps1"), "utf8");

  test("build.ps1 never installs anything and never runs the MSI", () => {
    expect(build).not.toMatch(/msiexec/i);
    expect(build).not.toMatch(/dotnet\s+tool/i);
    expect(build).not.toMatch(/winget/i);
    expect(build).not.toMatch(/\bchoco\b|\bscoop\b|Install-Package|Install-Module/i);
    expect(build).not.toMatch(/Start-Process/i);
  });

  test("build.ps1 builds x64, pins the extensions to the wix version, and needs the EULA flag to accept it", () => {
    expect(build).toContain("WixToolset.UI.wixext/$wixVersion");
    expect(build).toContain("WixToolset.Util.wixext/$wixVersion");
    expect(build).toContain("'-acceptEula', 'wix7'");
    expect(build).toMatch(/if \(\$AcceptEula\)/);
    expect(build).toContain("[ValidatePattern('^\\d+\\.\\d+\\.\\d+$')]");
    expect(build).toMatch(/was not found/);
  });

  test("build.ps1 checks the WebView2 bootstrapper against the pin file and refuses a mismatch", () => {
    expect(build).toContain("webview2-bootstrapper.sha256");
    expect(build).toContain("-Algorithm SHA256");
    expect(build).toMatch(/Refusing to package it/);
    const pin = readFileSync(join(installerDir, "webview2-bootstrapper.sha256"), "utf8");
    const lines = pin.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    // Empty until the owner pins it on a PC with internet; when set it must be a SHA-256.
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64}(\s+\S+)?$/i);
  });

  test("build.ps1 passes every source file to wix", () => {
    for (const file of WXS_FILES) expect(build, file).toContain(`'${file}'`);
  });

  test("Tauri's own MSI bundle stays off", () => {
    const config = JSON.parse(readFileSync(join(repoRoot, "apps/staff-app/src-tauri/tauri.conf.json"), "utf8")) as {
      bundle?: { active?: boolean; targets?: unknown };
    };
    const targets = config.bundle?.targets;
    const msiTargeted = targets === "all" || (Array.isArray(targets) && targets.includes("msi"));
    expect(config.bundle?.active === true && (targets === undefined || msiTargeted)).toBe(false);
  });
});
