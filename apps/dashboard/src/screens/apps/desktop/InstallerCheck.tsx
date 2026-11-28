import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { Button, Input } from "@rulebox/ui";
import IconFile from "~icons/solar/file-check-linear";
import IconRefresh from "~icons/solar/refresh-linear";
import { Field } from "../../../components/Field";
import { InlineNotice } from "../../../components/Notice";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import * as v from "../../../lib/validate";
import type { FormApi } from "../appForm";
import { foundLine, type InstallerCheck as Check } from "./useInstallerCheck";

const t = appAddStrings.installer;

/**
 * "Installer link": one field. A valid https link is checked by itself once the person leaves the box, presses Enter or pastes it
 * (the server downloads the file once, hashes it and reads what kind of installer it is), so no SHA-256 and no switches are asked up
 * front. "I have the file" reads a file on this computer instead (nothing is uploaded). Results and refusals stay visible under the field.
 */
export function InstallerCheck({ f, check, readOnly = false, label = t.link }: { f: FormApi; check: Check; readOnly?: boolean; label?: string }) {
  const x = f.values;
  const chooser = useRef<HTMLInputElement>(null);
  // The link that was tried last: leaving the box twice never downloads the same file twice (the server allows 10 checks an hour).
  const tried = useRef<string | null>(null);
  const link = x.installUrl.trim();
  const valid = v.installerUrl(link) === null;

  function start(url: string) {
    if (v.installerUrl(url) !== null || tried.current === url.trim()) return;
    tried.current = url.trim();
    check.run(url);
  }
  function again() {
    tried.current = link;
    check.run(link);
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && valid) {
      e.preventDefault();
      start(link);
    }
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text").trim();
    const el = e.currentTarget;
    const next = `${el.value.slice(0, el.selectionStart ?? 0)}${pasted}${el.value.slice(el.selectionEnd ?? el.value.length)}`.trim();
    if (v.installerUrl(next) !== null) return;
    e.preventDefault();
    f.set("installUrl", next);
    if (check.checkedUrl !== null && next !== check.checkedUrl) check.forget();
    start(next);
  }

  const busy = check.phase === "checking";
  const found = check.inspect.result;
  return (
    <div className="apps-check">
      <Field label={label} info={t.linkInfo} error={f.errors.installUrl} required>
        {(p) => (
          <div className="apps-check__row">
            <Input
              {...p}
              type="url"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t.linkPlaceholder}
              value={x.installUrl}
              disabled={readOnly}
              onChange={(e) => {
                f.set("installUrl", e.target.value);
                if (check.checkedUrl !== null && e.target.value.trim() !== check.checkedUrl) {
                  check.forget();
                  tried.current = null;
                }
              }}
              onBlur={() => start(link)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            {!readOnly ? (
              <Button type="button" variant="ghost" className="apps-check__file" disabled={busy} onClick={() => chooser.current?.click()}>
                <IconFile aria-hidden="true" />
                {t.file}
              </Button>
            ) : null}
            <input
              ref={chooser}
              type="file"
              accept=".exe,.msi"
              className="dash-sr"
              tabIndex={-1}
              aria-label={t.chooseFile}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) check.runFile(file);
              }}
            />
          </div>
        )}
      </Field>

      {busy ? (
        <div className="apps-check__busy" role="status">
          <span className="dash-spin" aria-hidden="true" />
          <span>{t.checking}</span>
          <Button type="button" variant="ghost" className="dash-btn--sm" onClick={check.cancel}>
            {t.cancel}
          </Button>
        </div>
      ) : null}
      {!busy && check.error !== null ? (
        <InlineNotice
          tone={check.tooBig ? "warning" : "danger"}
          alert
          title={check.error}
          action={
            valid && !check.tooBig && !readOnly ? (
              <Button type="button" variant="ghost" className="dash-btn--sm" onClick={again}>
                <IconRefresh aria-hidden="true" />
                {t.checkAgain}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {!busy && check.note !== null ? <InlineNotice tone="warning" title={check.note} /> : null}
      {!busy && found !== null && (check.error === null || check.tooBig) ? <InlineNotice tone="success" title={foundLine(found, check.sizeBytes)} detail={check.inspect.note ?? undefined} /> : null}
    </div>
  );
}
