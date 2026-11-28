// Small pure helpers of the Updates section (UI pass): the file name of an installer address and the inline checks of the
// "use your own build" fields. No sentences of their own beyond `updates.problems`.
import type { GithubReleasesHandle } from "../../../data/release/api";
import { updates as s } from "../strings";
import {
  releaseSizeProblem,
  releaseUrlProblem,
  sha256Problem,
  versionProblem,
  type ReleaseFields,
} from "../releaseRules";

/** `Rulebox-0.2.1-x64.msi` from `https://github.com/.../Rulebox-0.2.1-x64.msi`; the address itself when it has no file part. */
export function fileNameOf(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return url;
  }
}

const VERSION_TEXT = { empty: s.problems.versionEmpty, length: s.problems.versionLength, not_ordered: s.problems.versionNotOrdered };
const URL_TEXT = { empty: s.problems.urlEmpty, length: s.problems.urlLength, https: s.problems.urlHttps };
const SHA_TEXT = { empty: s.problems.shaEmpty, format: s.problems.shaFormat };
const SIZE_TEXT = { empty: s.problems.sizeEmpty, number: s.problems.sizeNumber, range: s.problems.sizeRange };

export type FieldProblems = Partial<Record<keyof ReleaseFields, string>>;

/** The sentence under each field, or nothing when the field is fine. */
export function problemsOf(f: ReleaseFields): FieldProblems {
  const version = versionProblem(f.version);
  const url = releaseUrlProblem(f.url);
  const sha = sha256Problem(f.sha256);
  const size = releaseSizeProblem(f.size);
  return {
    version: version ? VERSION_TEXT[version] : undefined,
    url: url ? URL_TEXT[url] : undefined,
    sha256: sha ? SHA_TEXT[sha] : undefined,
    size: size ? SIZE_TEXT[size] : undefined,
  };
}

export const hasProblem = (p: FieldProblems): boolean => Object.values(p).some(Boolean);

export const sameFields = (a: ReleaseFields, b: ReleaseFields): boolean =>
  a.version === b.version && a.url === b.url && a.sha256 === b.sha256 && a.size === b.size;

/** What the Releases card shows, so the screen can open "Advanced" when there is nothing to pick from. */
export type PickerView = "loading" | "list" | "empty" | "unavailable";

export function pickerView(state: GithubReleasesHandle["state"]): PickerView {
  if (state.status === "idle" || state.status === "loading") return "loading";
  if (state.status === "error") return "unavailable";
  if (state.data.status === "unavailable") return "unavailable";
  return state.data.releases.length === 0 ? "empty" : "list";
}
