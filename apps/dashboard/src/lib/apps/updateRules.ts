// Versions and update modes (Phase 6 Step 10): the inline checks of the form. They mirror convex/lib/appRules.ts and convex/lib/feed/version.ts;
// the server decides. Not part of `validate.ts` (which the first load carries): only the App screen and the demo use them.

/** 1 to 40 characters of `[0-9A-Za-z.+-]`: the text a version may have (an empty text means "no version"). */
export function isVersionText(value: string): boolean {
  const t = value.trim();
  return t.length >= 1 && t.length <= 40 && /^[0-9A-Za-z.+-]+$/.test(t);
}

/** Up to four dotted numbers, then an optional `-pre-release`: the versions Rulebox can compare (plan 4.4.1). */
export function isOrderedVersion(value: string): boolean {
  const t = value.trim();
  return t.length <= 40 && /^[0-9]+(\.[0-9]+){0,3}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(t);
}

/**
 * Whether `a` has larger numbers than `b` (the first four, a missing one is 0; a pre-release ending is ignored: the server
 * decides the close cases). False when either is not ordered.
 */
export function numbersAbove(a: string, b: string): boolean {
  if (!isOrderedVersion(a) || !isOrderedVersion(b)) return false;
  const parts = (t: string) => {
    const nums = (t.trim().split("-")[0] ?? "").split(".").map((x) => Number(x));
    while (nums.length < 4) nums.push(0);
    return nums;
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
/** Windows' own signers: a publisher rule for one of them with no product would allow most of Windows. */
const BROAD_PUBLISHERS: ReadonlySet<string> = new Set(["microsoft windows", "microsoft corporation", "microsoft windows publisher"]);

/** The subject as typed or as a distinguished name (`CN=..., O=...`): any of its names is broad. */
export function publisherTooBroad(subject: string): boolean {
  const names = [subject, ...[...subject.matchAll(/(?:^|,)\s*(?:CN|O)=("?)([^",]+)\1/gi)].map((m) => m[2] ?? "")];
  return names.some((n) => BROAD_PUBLISHERS.has(n.trim().toLowerCase()));
}

/** Chrome or Edge added as a normal program: they can only be kept by their own updater. */
export function browserAppOf(exe: string): "chrome" | "edge" | null {
  const file = exe.split(/[\\/]/).pop()?.trim().toLowerCase();
  return file === "chrome.exe" ? "chrome" : file === "msedge.exe" ? "edge" : null;
}

/** A vendor's public key as pasted: base64, possibly wrapped over lines, 16 to 512 characters. */
export function isFeedKey(value: string): boolean {
  const t = value.replace(/\s+/g, "");
  return t.length >= 16 && t.length <= 512 && /^[A-Za-z0-9+/=]+$/.test(t);
}

/** The platform key of `latest.json`, like `windows-x86_64-nsis`. */
export function isFeedTarget(value: string): boolean {
  const t = value.trim();
  return t.length >= 3 && t.length <= 40 && /^[a-z0-9_-]+$/.test(t);
}
