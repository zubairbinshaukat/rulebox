import { useEffect, useRef, useState } from "react";
import { Button, Input, NativeSelect, Switch } from "@rulebox/ui";
import IconDetect from "~icons/solar/magnifer-linear";
import IconFile from "~icons/solar/file-check-linear";
import { useInspectInstaller } from "../data";
import { INSTALL_TECHS, type InstallerInspection, type WizardTech } from "../data/types";
import { Card } from "../components/Card";
import { Field } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { formatBytes } from "../lib/format";
import { messageFor } from "../lib/errors";
import { appInstallerStrings as s } from "../lib/screenStrings/appInstaller";
import { prefillFrom, type PrefillKey } from "../lib/apps/installerPrefill";
import * as v from "../lib/validate";
import type { FormApi } from "./apps/appForm";

// The installer details of a Windows program (Phase 6 Step 13, plan 4.7): "Detect" and "Check a file on this computer" next to the
// installer address, and the card with the technology, success codes, timeout, expected signer and answer file. One lazy chunk: most
// edits are of websites. Nothing here saves anything: a detection only fills fields the admin has not typed in, and the admin saves.

/** What the last detection said, kept by the form so the card and the row beside the address agree. */
export interface InspectState {
  result: InstallerInspection | null;
  from: "url" | "file" | null;
  /** Fields that had the admin's own text and were left alone. */
  kept: PrefillKey[];
  /** What was filled in, for the "edited" mark: a field is "edited" when it no longer says this. */
  prefilled: { silentArgs?: string; successCodes?: string };
  /** One line about the SHA-256 of a local file. */
  note: string | null;
}

/** A problem with the local file itself (not an error from the server): its message is already a sentence. */
class FileProblem extends Error {}

interface RowProps {
  f: FormApi;
  state: InspectState;
  setState: (next: InspectState) => void;
  readOnly: boolean;
}

/** The two buttons under the installer address and what they found. */
export function DetectRow({ f, state, setState, readOnly }: RowProps) {
  const inspect = useInspectInstaller();
  const x = f.values;
  // The newest values: a detection takes a moment and the admin may type meanwhile; typed text is never overwritten.
  const latest = useRef(x);
  useEffect(() => {
    latest.current = x;
  });
  const [busy, setBusy] = useState<"url" | "file" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const chooser = useRef<HTMLInputElement>(null);

  function apply(r: InstallerInspection, from: "url" | "file", note: string | null) {
    const now = latest.current;
    const { patch, kept, prefilled } = prefillFrom({ silentArgs: now.silentArgs, successCodes: now.successCodes, tech: now.tech, answerOn: now.answerOn }, r, v.joinArgs);
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) f.set(key as never, patch[key] as never);
    setState({ result: r, from, kept, prefilled, note });
  }

  async function detect() {
    setBusy("url");
    setError(null);
    try {
      apply(await inspect({ url: latest.current.installUrl.trim() }), "url", null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function checkFile(file: File) {
    setBusy("file");
    setError(null);
    try {
      // The detector and the hashing are a chunk of their own, loaded only now.
      const { checkLocalFile } = await import("../lib/apps/localInstaller");
      const checked = await checkLocalFile(file);
      if (checked.inspection === null) {
        setState({ result: null, from: null, kept: [], prefilled: {}, note: null });
        setError(new FileProblem(s.notInstaller));
        return;
      }
      const typed = latest.current.sha256.trim().toLowerCase();
      let note: string;
      if (typed === "") {
        f.set("sha256", checked.sha256);
        note = s.hashFilled;
      } else {
        note = typed === checked.sha256 ? s.hashSame : s.hashDiffers(checked.sha256);
      }
      apply({ ...checked.inspection, sizeBytes: checked.sizeBytes }, "file", note);
    } catch {
      setError(new FileProblem(s.fileFailed));
    } finally {
      setBusy(null);
    }
  }

  const r = state.result;
  return (
    <div className="dash-stack" style={{ gap: 10 }}>
      <div className="dash-row">
        <Button type="button" variant="ghost" disabled={busy !== null || readOnly || Boolean(v.installerUrl(x.installUrl))} aria-busy={busy === "url"} onClick={() => void detect()}>
          <IconDetect aria-hidden="true" />
          {busy === "url" ? s.detecting : s.detect}
        </Button>
        <Button type="button" variant="ghost" disabled={busy !== null || readOnly} aria-busy={busy === "file"} onClick={() => chooser.current?.click()}>
          <IconFile aria-hidden="true" />
          {busy === "file" ? s.checkingFile : s.checkFile}
        </Button>
        <input
          ref={chooser}
          type="file"
          accept=".exe,.msi"
          className="dash-sr"
          tabIndex={-1}
          aria-label={s.chooseFile}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void checkFile(file);
          }}
        />
      </div>
      <p className="dash-field__hint">{s.detectHint} {s.checkFileHint}</p>
      {error !== null ? <InlineNotice tone="danger" alert title={error instanceof FileProblem ? error.message : messageFor(error)} /> : null}
      {r !== null ? <DetectResult r={r} state={state} source={x.source} /> : null}
    </div>
  );
}

function DetectResult({ r, state, source }: { r: InstallerInspection; state: InspectState; source: string }) {
  const filled = Object.keys(state.prefilled).length > 0;
  const detail = (
    <>
      {r.tech === "exe" ? <>{s.unknownExe} </> : null}
      {r.signer !== undefined ? <>{s.signer(r.signer)} </> : null}
      {r.fileVersion !== undefined ? <>{s.version(r.fileVersion)} </> : null}
      {r.sizeBytes !== undefined ? <>{formatBytes(r.sizeBytes)}. </> : null}
      {state.note !== null ? <>{state.note} </> : null}
      {filled ? <>{s.prefilled} </> : <>{s.prefilledNothing} </>}
      {state.kept.map((k) => (
        <span key={k}>{s.kept(s.keptNames[k])} </span>
      ))}
    </>
  );
  return (
    <>
      <InlineNotice tone="success" title={s.looksLike(s.techNames[r.tech], r.confidence)} detail={detail} />
      {r.kind === "msi" && source !== "msi" ? <InlineNotice tone="warning" title={s.sourceMsi} /> : null}
      {r.kind === "exe" && source === "msi" ? <InlineNotice tone="warning" title={s.sourceExe} /> : null}
      {r.perUserLikely ? <InlineNotice tone="warning" title={s.perUser} /> : null}
    </>
  );
}

const edited = <span className="dash-field__optional"> ({s.edited})</span>;

/** The card under the program's source: technology, success codes, timeout, expected signer and answer file. */
export function InstallerCard({ f, state, readOnly }: { f: FormApi; state: InspectState; readOnly: boolean }) {
  const x = f.values;
  const exe = x.source === "exe";
  const text = (key: string, value: string) => f.set(key as never, value as never);
  const codesEdited = state.prefilled.successCodes !== undefined && x.successCodes.trim() !== state.prefilled.successCodes;
  const signer = state.result?.signer;
  return (
    <Card title={s.card} sub={s.cardSub}>
      <div className="dash-form">
        {exe ? (
          <Field label={s.tech} hint={s.techHint} optional>
            {(p) => (
              <NativeSelect {...p} value={x.tech} onChange={(e) => f.set("tech", e.target.value as WizardTech | "")}>
                <option value="">{s.techNone}</option>
                {INSTALL_TECHS.map((t) => (
                  <option key={t} value={t}>
                    {s.techOptions[t]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        {exe ? (
          <Field label={<>{s.successCodes}{codesEdited ? edited : null}</>} hint={s.successCodesHint} error={f.errors.successCodes} optional>
            {(p) => <Input {...p} className="dash-mono" spellCheck={false} inputMode="numeric" value={x.successCodes} onChange={(e) => text("successCodes", e.target.value)} />}
          </Field>
        ) : null}
        <div className="dash-form__row">
          <Field label={s.timeout} hint={s.timeoutHint} error={f.errors.timeoutMin} optional>
            {(p) => <Input {...p} className="dash-mono" inputMode="numeric" placeholder="30" maxLength={3} value={x.timeoutMin} onChange={(e) => text("timeoutMin", e.target.value)} />}
          </Field>
          <Field label={s.publisher} hint={s.publisherHint} error={f.errors.installPublisher} optional>
            {(p) => <Input {...p} spellCheck={false} autoComplete="off" maxLength={200} value={x.installPublisher} onChange={(e) => text("installPublisher", e.target.value)} />}
          </Field>
        </div>
        {signer !== undefined && x.installPublisher.trim() === "" && !readOnly ? (
          <div className="dash-row">
            <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => text("installPublisher", signer)}>
              {s.useSigner(signer)}
            </Button>
          </div>
        ) : null}

        {exe ? (
          <>
            <Switch checked={x.answerOn} onChange={(val) => f.set("answerOn", val)} label={s.answerOn} disabled={readOnly} />
            {x.tech === "installshield_script" && !x.answerOn ? <InlineNotice tone="warning" title={s.answerNeeded} /> : null}
            {x.answerOn ? (
              <>
                <p className="dash-field__hint">{s.answerHint}</p>
                <Field label={s.answerUrl} hint={s.answerUrlHint} error={f.errors.answerUrl} required>
                  {(p) => <Input {...p} type="url" inputMode="url" spellCheck={false} autoCapitalize="off" placeholder="https://" value={x.answerUrl} onChange={(e) => text("answerUrl", e.target.value)} />}
                </Field>
                <Field label={s.answerSha} error={f.errors.answerSha256} required>
                  {(p) => <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={80} value={x.answerSha256} onChange={(e) => text("answerSha256", e.target.value)} />}
                </Field>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
