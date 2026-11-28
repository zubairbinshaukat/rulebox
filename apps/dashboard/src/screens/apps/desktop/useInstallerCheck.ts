/**
 * Checking an installer from its link (`apps:fingerprintInstaller`) or from a file on this computer, and what the answer fills into the
 * form: the SHA-256 (the PCs refuse a file that changed), the type (MSI or program), the automatic silent switches, the success codes,
 * the name. Nothing here saves anything; the admin adds or saves. Text the admin typed is never overwritten (`prefillFrom`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFingerprintInstaller, useInspectInstaller } from "../../../data";
import type { InstallerInspection } from "../../../data/types";
import { messageFor, toAppError } from "../../../lib/errors";
import { prefillFrom } from "../../../lib/apps/installerPrefill";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import * as v from "../../../lib/validate";
import type { FormApi } from "../appForm";
import type { InspectState } from "../../AppInstaller";
import { formatBytes } from "../../../lib/format";
import { nameFromUrl } from "./model";

const t = appAddStrings.installer;

export type CheckPhase = "idle" | "checking" | "done";

export interface InstallerCheck {
  phase: CheckPhase;
  /** A plain sentence for the last refusal, or `null`. */
  error: string | null;
  /** The file is over what the server downloads: the type came from a few byte ranges and the hash needs the file on this computer. */
  tooBig: boolean;
  /** What was found (the form's `InspectState`: the last detection, what was left alone, what was filled in). */
  inspect: InspectState;
  /** The link the last successful check was for. */
  checkedUrl: string | null;
  sizeBytes: number | null;
  /** One line about a local file ("This file is different from the one at the link."). */
  note: string | null;
  run: (url: string) => void;
  runFile: (file: File) => void;
  cancel: () => void;
  /** Forget the result (the link changed). The SHA-256 the check filled in is cleared too, a typed one is not. */
  forget: () => void;
}

const EMPTY: InspectState = { result: null, from: null, kept: [], prefilled: {}, note: null };

/** A sentence for what the server (or the file) said, in the words of the page. */
export function checkErrorText(e: unknown): string {
  const err = toAppError(e);
  if (err?.code === "invalid_argument") {
    switch (err.detail) {
      case "fingerprint_blocked":
      case "inspect_blocked":
        return t.blocked;
      case "fingerprint_failed":
      case "inspect_failed":
        return t.failed;
      case "fingerprint_not_installer":
      case "inspect_not_installer":
        return t.notInstaller;
      default:
        if (err.field === "url") return t.blocked;
    }
  }
  if (err?.code === "rate_limited") return t.rateLimited;
  return messageFor(e);
}

class FileProblem extends Error {}

export function useInstallerCheck(f: FormApi): InstallerCheck {
  const fingerprint = useFingerprintInstaller();
  const inspectRanges = useInspectInstaller();
  const [phase, setPhase] = useState<CheckPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [inspect, setInspect] = useState<InspectState>(EMPTY);
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The newest form values and state: a check takes a moment and the admin may type meanwhile.
  const latest = useRef(f.values);
  const state = useRef({ inspect, autoSha: "" });
  useEffect(() => {
    latest.current = f.values;
    state.current.inspect = inspect;
  });
  // A check that was cancelled or replaced answers into the void.
  const token = useRef(0);
  const set = f.set;

  const apply = useCallback(
    (r: InstallerInspection, from: "url" | "file", url: string, line: string | null) => {
      const now = latest.current;
      const before = state.current.inspect;
      // What an earlier check filled in counts as empty again: a new link brings its own switches. Typed text still wins.
      const mine = before.prefilled;
      const current = {
        silentArgs: mine.silentArgs !== undefined && now.silentArgs.trim() === mine.silentArgs ? "" : now.silentArgs,
        successCodes: mine.successCodes !== undefined && now.successCodes.trim() === mine.successCodes ? "0" : now.successCodes,
        tech: before.result !== null && now.tech === (before.result.tech === "exe" || before.result.tech === "msi" ? "" : before.result.tech) ? ("" as const) : now.tech,
        answerOn: now.answerOn,
      };
      const { patch, kept, prefilled } = prefillFrom(current, r, v.joinArgs);
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) set(key as never, patch[key] as never);
      if (now.source === "exe" || now.source === "msi") {
        const source = r.kind === "msi" ? "msi" : "exe";
        if (source !== now.source) set("source", source);
      }
      if (now.name.trim() === "") {
        const name = r.productName?.trim() || nameFromUrl(url);
        if (name !== "") set("name", name.slice(0, v.NAME_MAX.app));
      }
      setInspect({ result: r, from, kept, prefilled, note: line });
    },
    [set],
  );

  const run = useCallback(
    (url: string) => {
      const link = url.trim();
      if (v.installerUrl(link) !== null) return;
      const mine = ++token.current;
      setPhase("checking");
      setError(null);
      setTooBig(false);
      setNote(null);
      fingerprint({ url: link }).then(
        (r) => {
          if (mine !== token.current) return;
          const now = latest.current;
          if (now.sha256.trim() === "" || now.sha256.trim().toLowerCase() === state.current.autoSha) {
            set("sha256", r.sha256);
            state.current.autoSha = r.sha256;
          }
          setSizeBytes(r.sizeBytes);
          setCheckedUrl(link);
          if (r.inspection !== null) apply({ ...r.inspection, sizeBytes: r.sizeBytes }, "url", link, null);
          setPhase("done");
        },
        async (e: unknown) => {
          if (mine !== token.current) return;
          const err = toAppError(e);
          if (err?.detail === "fingerprint_too_large") {
            // Too big to download: the type still comes from a few byte ranges, the hash from the file on this computer.
            setTooBig(true);
            try {
              const r = await inspectRanges({ url: link });
              if (mine === token.current) {
                setCheckedUrl(link);
                apply(r, "url", link, null);
              }
            } catch {
              /* the sentence below already says what to do */
            }
            if (mine !== token.current) return;
            setError(t.tooBig);
          } else {
            setError(checkErrorText(e));
          }
          setPhase("done");
        },
      );
    },
    [fingerprint, inspectRanges, apply, set],
  );

  const runFile = useCallback(
    (file: File) => {
      const mine = ++token.current;
      setPhase("checking");
      setError(null);
      void (async () => {
        try {
          // The detector and the hashing are a chunk of their own, loaded only now.
          const { checkLocalFile } = await import("../../../lib/apps/localInstaller");
          const checked = await checkLocalFile(file);
          if (mine !== token.current) return;
          if (checked.inspection === null) throw new FileProblem(t.notInstaller);
          const now = latest.current;
          const typed = now.sha256.trim().toLowerCase();
          let line: string | null = null;
          if (typed === "" || typed === state.current.autoSha) {
            set("sha256", checked.sha256);
            state.current.autoSha = checked.sha256;
            setSizeBytes(checked.sizeBytes);
          } else if (typed !== checked.sha256) {
            // A file that is not the one at the link: nothing changes.
            setNote(t.differs);
            setError(null);
            setPhase("done");
            return;
          }
          setTooBig(false);
          line = t.fromFile;
          apply({ ...checked.inspection, sizeBytes: checked.sizeBytes }, "file", now.installUrl, line);
          setPhase("done");
        } catch (e) {
          if (mine !== token.current) return;
          setError(e instanceof FileProblem ? e.message : t.fileFailed);
          setPhase("done");
        }
      })();
    },
    [apply, set],
  );

  const cancel = useCallback(() => {
    token.current++;
    setPhase("idle");
  }, []);

  const forget = useCallback(() => {
    token.current++;
    setPhase("idle");
    setError(null);
    setTooBig(false);
    setNote(null);
    setCheckedUrl(null);
    setSizeBytes(null);
    setInspect(EMPTY);
    if (latest.current.sha256.trim().toLowerCase() === state.current.autoSha && state.current.autoSha !== "") set("sha256", "");
    state.current.autoSha = "";
  }, [set]);

  return { phase, error, tooBig, inspect, checkedUrl, sizeBytes, note, run, runFile, cancel, forget };
}

/** "Checked: Zahras POS 2.4, Inno Setup installer, 84 MB". */
export function foundLine(r: InstallerInspection, sizeBytes: number | null): string {
  return t.found(r.productName ?? "", r.fileVersion ?? "", appAddStrings.silent.techName[r.tech], formatBytes(sizeBytes ?? r.sizeBytes ?? 0));
}
