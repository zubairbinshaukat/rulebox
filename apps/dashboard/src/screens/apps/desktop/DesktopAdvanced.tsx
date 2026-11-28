import { useState, type ReactNode } from "react";
import { Button, Input, Textarea } from "@rulebox/ui";
import { useResolveWinget } from "../../../data";
import { Field, FieldSet } from "../../../components/Field";
import { InlineNotice } from "../../../components/Notice";
import { formatBytes, shortHex } from "../../../lib/format";
import { messageFor } from "../../../lib/errors";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../../lib/screenStrings/appEdit";
import { appInstallerStrings } from "../../../lib/screenStrings/appInstaller";
import * as v from "../../../lib/validate";
import { InstallCommand } from "../../AppInstaller";
import type { FormApi } from "../appForm";
import { InstallerCheck } from "./InstallerCheck";
import { automaticOf } from "./model";
import type { InstallerCheck as Check } from "./useInstallerCheck";

const t = appAddStrings;
const e = appEditStrings;

/**
 * The "Advanced" disclosure of a Windows app: the technical values nobody has to touch (the install command with its automatic
 * switches, the installer's fingerprint, another winget version, the start arguments). It is controlled so a warning elsewhere on the
 * page ("Rulebox can't tell how this installer runs silently") can open it.
 */
export function DesktopAdvanced({
  f,
  check,
  readOnly,
  open,
  onOpen,
  linkHere,
  children,
}: {
  f: FormApi;
  check: Check;
  readOnly: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Show the installer link here (the edit page); the add flow asks for it up front. */
  linkHere: boolean;
  /** More rows at the end (the browser rules of a Chrome or Edge program). */
  children?: ReactNode;
}) {
  const x = f.values;
  const own = x.source === "msi" || x.source === "exe";
  const automatic = automaticOf(x, check.inspect.result);
  return (
    <details className="dash-advanced apps-advanced" open={open} onToggle={(ev) => onOpen(ev.currentTarget.open)}>
      <summary>{t.advanced}</summary>
      <div className="dash-advanced__body">
        {x.source === "winget" ? <WingetFacts f={f} readOnly={readOnly} /> : null}
        {(own || x.source === "portable") && linkHere ? <InstallerCheck f={f} check={check} readOnly={readOnly} /> : null}
        {(own || x.source === "portable") ? <Fingerprint f={f} readOnly={readOnly} /> : null}
        {own ? (
          <FieldSet legend={appInstallerStrings.advancedGroup}>
            <InstallCommand f={f} state={check.inspect} automatic={automatic} readOnly={readOnly} />
          </FieldSet>
        ) : null}
        <FieldSet legend={t.advancedGroups.program}>
          <div className="dash-form-grid">
            <Field label={e.args} info={e.info.args} error={f.errors.args} optional>
              {(p) => <Input {...p} className="dash-mono" spellCheck={false} value={x.args} disabled={readOnly} onChange={(ev) => f.set("args", ev.target.value)} />}
            </Field>
            <Field label={e.fileArg} info={e.info.fileArg} error={f.errors.fileArg} optional>
              {(p) => <Input {...p} className="dash-mono" spellCheck={false} value={x.fileArg} disabled={readOnly} onChange={(ev) => f.set("fileArg", ev.target.value)} />}
            </Field>
            <div className="dash-form-grid__full">
              <Field label={e.resetFolders} info={e.info.resetFolders} error={f.errors.resetFolders} optional>
                {(p) => <Textarea {...p} rows={3} className="dash-mono" spellCheck={false} value={x.resetFolders} disabled={readOnly} onChange={(ev) => f.set("resetFolders", ev.target.value)} />}
              </Field>
            </div>
          </div>
        </FieldSet>
        {children}
      </div>
    </details>
  );
}

/** The SHA-256 of an installer: read-only text with a Change button (the server's check or winget filled it in). Editable while empty. */
function Fingerprint({ f, readOnly }: { f: FormApi; readOnly: boolean }) {
  const x = f.values;
  const [editing, setEditing] = useState(false);
  const typed = editing || x.sha256.trim() === "";
  return (
    <Field label={t.installer.hashAdvanced} info={appInstallerStrings.info.fingerprint} error={f.errors.sha256} required>
      {(p) =>
        typed ? (
          <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" maxLength={80} value={x.sha256} disabled={readOnly} onChange={(ev) => f.set("sha256", ev.target.value)} />
        ) : (
          <div className="apps-check__row">
            <output {...p} className="dash-mono apps-fact__value" title={x.sha256}>
              {shortHex(x.sha256, 16, 8)}
            </output>
            {!readOnly ? (
              <Button type="button" variant="ghost" className="dash-btn--sm" onClick={() => setEditing(true)}>
                {appInstallerStrings.change}
              </Button>
            ) : null}
          </div>
        )
      }
    </Field>
  );
}

/** What winget said, as plain facts, and "Choose another version" (a new look-up of the same package). */
function WingetFacts({ f, readOnly }: { f: FormApi; readOnly: boolean }) {
  const x = f.values;
  const resolve = useResolveWinget();
  const [version, setVersion] = useState("");
  const [state, setState] = useState<{ pending: boolean; error: string | null; done: string | null }>({ pending: false, error: null, done: null });
  const r = x.resolved;
  async function useVersion() {
    if (!r) return;
    setState({ pending: true, error: null, done: null });
    try {
      const next = await resolve({ packageId: r.packageId, version: version.trim() });
      // The same fields the first look-up filled: only the installer, its switches and the version move.
      const keepVersion = x.version.trim() === "" || x.version.trim() === r.version;
      f.set("resolved", next);
      f.set("wingetVersion", next.version);
      f.set("silentArgs", v.joinArgs(next.install.silentArgs));
      f.set("removeWhenUnassigned", next.install.removeWhenUnassigned);
      if (keepVersion) f.set("version", next.version);
      setState({ pending: false, error: null, done: e.resolved(next.packageId, next.version) });
      setVersion("");
    } catch (err) {
      setState({ pending: false, error: messageFor(err), done: null });
    }
  }
  if (!r) return null;
  return (
    <FieldSet legend={t.advancedGroups.source}>
      <dl className="dash-kv apps-facts">
        <Fact label={e.wingetId} value={r.packageId} />
        <Fact label={e.wingetVersion} value={r.version} />
        <Fact label={t.installer.hashAdvanced} value={shortHex(r.install.sha256, 16, 8)} title={r.install.sha256} />
        {r.install.sizeBytes ? <Fact label={e.sizeBytes} value={formatBytes(r.install.sizeBytes)} mono={false} /> : null}
        {r.install.silentArgs.length ? <Fact label={e.silentArgs} value={v.joinArgs(r.install.silentArgs)} /> : null}
        <Fact label={e.installerUrl} value={r.install.url} wide />
      </dl>
      {!readOnly ? (
        <div className="apps-version">
          <Field label={t.chooseVersion} info={appInstallerStrings.info.wingetVersion} className="apps-version__field">
            {(p) => (
              <div className="apps-check__row">
                <Input {...p} className="dash-mono" spellCheck={false} autoCapitalize="off" placeholder={r.version} value={version} onChange={(ev) => setVersion(ev.target.value)} />
                <Button type="button" variant="ghost" disabled={state.pending || version.trim() === ""} aria-busy={state.pending} onClick={() => void useVersion()}>
                  {state.pending ? e.resolving : t.useVersion}
                </Button>
              </div>
            )}
          </Field>
          {state.error ? <InlineNotice tone="danger" alert title={state.error} /> : null}
          {state.done ? <InlineNotice tone="success" title={state.done} /> : null}
        </div>
      ) : null}
    </FieldSet>
  );
}

function Fact({ label, value, title, wide = false, mono = true }: { label: string; value: string; title?: string; wide?: boolean; mono?: boolean }) {
  return (
    <div className="dash-kv__item" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <dt>{label}</dt>
      <dd className={mono ? "dash-mono apps-fact__value" : "apps-fact__value"} title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}
