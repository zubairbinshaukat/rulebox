import { useEffect, useState, type CSSProperties } from "react";
import { renderAsync } from "docx-preview";

import { fileErrorText, isFileError } from "../files/errors";
import { call } from "../../lib/tauri";
import { DOCX_FRAME_SANDBOX, docxSrcdoc, sanitizeDocx } from "./docxFrame";
import { fileNameOf, rbfileUrl } from "./kind";
import { OpenWith } from "./OpenWith";
import { ViewerLoading, ViewerMessage } from "./ViewerMessage";

/** A parse that takes longer than this is given up on: "Preview not available". */
const PARSE_TIMEOUT_MS = 15_000;

type State = { srcdoc: string } | { message: string } | null;

/**
 * A Word document, read-only. The file is size- and zip-checked by the
 * backend first. The converter's output is sanitised and shown in a frame
 * with no scripts and no network (see `docxFrame.ts`); macros never run.
 */
export default function DocxViewer({ path }: { path: string }) {
  const [state, setState] = useState<State>(null);

  useEffect(() => {
    let current = true;
    const fail = (message: string) => {
      if (current) setState({ message });
    };

    async function load() {
      try {
        await call("fs_office_check", { path });
      } catch (error) {
        fail(isFileError(error) && error.kind === "tooLarge" ? "Too large to preview." : fileErrorText(error));
        return;
      }
      const host = document.createElement("div");
      // The converter measures text, so the container must be in the page while it works.
      host.style.cssText = "position:fixed;left:-100000px;top:0;width:900px;visibility:hidden";
      document.body.append(host);
      try {
        const response = await fetch(rbfileUrl(path));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        await Promise.race([
          renderAsync(data, host, host, {
            className: "docx",
            // Pictures become data: addresses: the frame has no origin to resolve a blob: one.
            useBase64URL: true,
            ignoreLastRenderedPageBreak: true,
            experimental: false,
          }),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), PARSE_TIMEOUT_MS)),
        ]);
        if (current) setState({ srcdoc: docxSrcdoc(sanitizeDocx(host.innerHTML)) });
      } catch {
        fail("Preview not available.");
      } finally {
        host.remove();
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [path]);

  if (!state) return <ViewerLoading label="Preparing document…" />;
  if ("message" in state) {
    return (
      <ViewerMessage title={state.message} detail={fileNameOf(path)}>
        <OpenWith path={path} />
      </ViewerMessage>
    );
  }
  return <iframe title={fileNameOf(path)} sandbox={DOCX_FRAME_SANDBOX} srcDoc={state.srcdoc} style={frame} />;
}

const frame: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  border: 0,
  background: "#e8e6e1",
};
