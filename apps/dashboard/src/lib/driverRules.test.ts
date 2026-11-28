import { describe, expect, it } from "vitest";
import { kindFromUrl, MAX_DRIVER_NAME, nameFromUrl } from "./driverRules";

describe("kindFromUrl (what a link or a picked file delivers)", () => {
  it("a zip is a driver package, an msi is an MSI, an exe is a vendor installer", () => {
    expect(kindFromUrl("https://example.com/drivers/hp-universal.zip")).toBe("inf");
    expect(kindFromUrl("https://example.com/drivers/Canon_UFR2.MSI")).toBe("msi");
    expect(kindFromUrl("https://example.com/Setup.Exe")).toBe("exe");
  });

  it("looks at the file, not at the query or the fragment", () => {
    expect(kindFromUrl("https://example.com/dl.php?file=driver.zip")).toBeNull();
    expect(kindFromUrl("https://example.com/files/driver.zip?token=abc.exe#x.msi")).toBe("inf");
    expect(kindFromUrl("https://example.com/files/driver.exe#download")).toBe("exe");
  });

  it("works on a plain file name too, with either kind of slash", () => {
    expect(kindFromUrl("driver.zip")).toBe("inf");
    expect(kindFromUrl("C:\\Users\\me\\Downloads\\driver.msi")).toBe("msi");
  });

  it("says nothing when the ending says nothing", () => {
    for (const x of ["", "   ", "https://example.com/", "https://example.com/driver", "https://example.com/driver.7z", "https://example.com/zip", "https://example.com/driver.zip.txt"]) {
      expect(kindFromUrl(x), x).toBeNull();
    }
  });
});

describe("nameFromUrl (a readable name from the file in the link)", () => {
  it("drops the extension and turns underscores and plus signs into spaces", () => {
    expect(nameFromUrl("https://example.com/files/HP_Universal_Print_Driver_PCL6.zip")).toBe("HP Universal Print Driver PCL6");
    expect(nameFromUrl("https://example.com/Canon+UFR+II.msi")).toBe("Canon UFR II");
    expect(nameFromUrl("https://example.com/Setup.exe")).toBe("Setup");
  });

  it("hyphens become spaces only when the name has no space at all", () => {
    expect(nameFromUrl("https://example.com/hp-universal-print.zip")).toBe("hp universal print");
    expect(nameFromUrl("https://example.com/hp_universal-print.zip")).toBe("hp universal-print");
  });

  it("decodes percent escapes, ignores the query and keeps the version dots", () => {
    expect(nameFromUrl("https://example.com/Brother%20HL-L2350.zip?download=1")).toBe("Brother HL-L2350");
    expect(nameFromUrl("https://example.com/driver-v7.0.1.zip#top")).toBe("driver v7.0.1");
    expect(nameFromUrl("https://example.com/%E0%A4%A.zip")).toBe("%E0%A4%A"); // a broken escape stays as it is
  });

  it("is at most 60 characters, has no control characters and is empty when the link has no file", () => {
    expect(Array.from(nameFromUrl(`https://example.com/${"a".repeat(100)}.zip`))).toHaveLength(MAX_DRIVER_NAME);
    expect(nameFromUrl("https://example.com/a%00b%07c.zip")).toBe("abc");
    expect(nameFromUrl("https://example.com/")).toBe("");
    expect(nameFromUrl("")).toBe("");
    expect(nameFromUrl("https://example.com/.zip")).toBe("");
  });

  it("works on a picked file's name", () => {
    expect(nameFromUrl("My_Scanner_Driver.exe")).toBe("My Scanner Driver");
  });
});
