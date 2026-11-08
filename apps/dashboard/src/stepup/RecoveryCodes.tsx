import { useState } from "react";
import { Button } from "@rulebox/ui";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import { CopyField } from "../components/CopyField";
import { sec } from "../lib/stepup/strings";

/** Saves the codes as a plain text file (a Blob link; nothing leaves the browser). False where the browser cannot. */
function download(text: string): boolean {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = sec.codesFileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // After the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * The recovery codes, shown once: the list, Copy all and Download. The caller
 * keeps the codes in component state only and drops them when the screen
 * closes (they are never stored in the browser).
 */
export function RecoveryCodes({ codes, email }: { codes: readonly string[]; email: string }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="dash-form">
      <ul className="dash-codes" aria-label={sec.codesList}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <CopyField value={codes.join("\n")} label={sec.codesCopyAll} multiline />
      <div className="dash-form__actions">
        <Button variant="ghost" onClick={() => setSaved(download(sec.codesFile(email, new Date().toISOString().slice(0, 10), codes)))}>
          <IconDownload aria-hidden="true" />
          {sec.codesDownload}
        </Button>
        <span className="dash-muted" role="status">
          {saved ? sec.codesDownloaded : ""}
        </span>
      </div>
    </div>
  );
}
