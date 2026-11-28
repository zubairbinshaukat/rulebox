import { describe, expect, it } from "vitest";
import { actorKind, plainSummary } from "./auditText";

const sum = (action: string, summary: string) => plainSummary({ action, summary });

describe("plainSummary", () => {
  it("words every organization setting", () => {
    expect(sum("org.settingsChanged", "Changed organization settings: offlineDays, defaultQuotaGb, power, adminExit, name")).toBe(
      "Changed organization settings: offline sign-in days, default storage, power options, administrator exit, name",
    );
  });

  it("words the employee fields and keeps the name of the person", () => {
    expect(sum("employee.updated", "Changed the name, username, quota of Maria Fernanda")).toBe("Changed the name, sign-in name, storage of Maria Fernanda");
    // A name that contains " of " is still the person.
    expect(sum("employee.updated", "Changed the username of Anna of Rome")).toBe("Changed the sign-in name of Anna of Rome");
  });

  it("words the app permissions and keeps allowed / blocked", () => {
    expect(
      sum("app.permissionsChanged", "Changed permissions of PDF Reader: camera allowed, screenShare blocked, clipboardRead allowed, geolocation blocked"),
    ).toBe("Changed permissions of PDF Reader: camera allowed, screen sharing blocked, clipboard allowed, location blocked");
    for (const [key, word] of [["microphone", "microphone"], ["notifications", "notifications"], ["downloads", "downloads"], ["printing", "printing"], ["location", "location"]]) {
      expect(sum("app.permissionsChanged", `Changed permissions of A: ${key} blocked`)).toBe(`Changed permissions of A: ${word} blocked`);
    }
  });

  it("does not touch an app name that has a colon in it", () => {
    expect(sum("app.permissionsChanged", "Changed permissions of Zoom: Pro: camera allowed")).toBe("Changed permissions of Zoom: Pro: camera allowed");
    expect(sum("app.permissionsChanged", "Changed permissions of Zoom: Pro: screenShare allowed")).toBe("Changed permissions of Zoom: Pro: screen sharing allowed");
  });

  it("splits an unknown camelCase name into words in these actions", () => {
    expect(sum("org.settingsChanged", "Changed organization settings: idleTimeoutMinutes")).toBe("Changed organization settings: idle timeout minutes");
    expect(sum("app.permissionsChanged", "Changed permissions of A: usbDevices allowed")).toBe("Changed permissions of A: usb devices allowed");
    expect(sum("group.displayModeChanged", "Changed the display settings of the group Front desk: windowCap, idle close off")).toBe(
      "Changed the display settings of the group Front desk: window cap, idle close off",
    );
  });

  it("leaves the display settings sentence and the group name alone", () => {
    const s = "Changed the display settings of the group iPhone Repair: display mode lite, at most 3 web windows, idle close after 5 min";
    expect(sum("group.displayModeChanged", s)).toBe(s);
  });

  it("leaves other summaries of these actions as written", () => {
    expect(sum("employee.updated", "Unlocked the employee Maria")).toBe("Unlocked the employee Maria");
    expect(sum("org.settingsChanged", "Something else entirely")).toBe("Something else entirely");
    expect(sum("org.settingsChanged", "Changed organization settings: ")).toBe("Changed organization settings: ");
  });

  it("leaves every other action as written, even with camelCase in it", () => {
    for (const action of ["app.assigned", "device.renamed", "lockdown.settingsChanged", "wifi.created"]) {
      const s = "Assigned offlineDays and screenShare to Front desk";
      expect(sum(action, s)).toBe(s);
    }
    expect(sum("unknown.action", "")).toBe("");
  });
});

describe("actorKind", () => {
  it("names who did it in plain words", () => {
    expect(actorKind("member")).toBe("Team member");
    expect(actorKind("device")).toBe("PC");
    expect(actorKind("system")).toBe("Rulebox");
  });
});
