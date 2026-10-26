import { useEffect, useState, type CSSProperties } from "react";
import { rovingKeyDown } from "@rulebox/ui";

import { fileErrorText, isFileError } from "../files/errors";
import { call } from "../../lib/tauri";
import { CsvTable } from "./CsvTable";
import { fileNameOf, rbfileUrl } from "./kind";
import { OpenWith } from "./OpenWith";
import { ViewerBanner, ViewerLoading, ViewerMessage } from "./ViewerMessage";
import type { SheetData, WorkerReply } from "./xlsxRead";

/** Parsing longer than this is given up on and the worker is stopped. */
const PARSE_TIMEOUT_MS = 15_000;
const MAX_ROWS = 2000;

type State = { sheets: SheetData[] } | { message: string } | null;

/**
 * A spreadsheet, read-only. The backend checks size and zip structure first;
 * the bytes are parsed in a worker (stopped after 15 seconds), formulas are
 * never evaluated, and the grid is our own, never generated HTML.
 */
export default function XlsxViewer({ path }: { path: string }) {
  const [state, setState] = useState<State>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let current = true;
    let worker: Worker | null = null;
    let timer: number | undefined;
    const fail = (message: string) => {
      if (current) setState({ message });
    };

    async function load() {
      try {
        await call("fs_office_check", { path });
        const response = await fetch(rbfileUrl(path));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        if (!current) return;
        worker = new Worker(new URL("./xlsxWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<WorkerReply>) => {
          window.clearTimeout(timer);
          if (current) {
            if (event.data.ok) setState({ sheets: event.data.sheets });
            else fail("Preview not available.");
          }
        };
        worker.onerror = () => {
          window.clearTimeout(timer);
          fail("Preview not available.");
        };
        timer = window.setTimeout(() => {
          worker?.terminate();
          fail("Preview not available.");
        }, PARSE_TIMEOUT_MS);
        worker.postMessage(data, [data]);
      } catch (error) {
        fail(isFileError(error) && error.kind === "tooLarge" ? "Too large to preview." : isFileError(error) ? fileErrorText(error) : "Preview not available.");
      }
    }
    void load();
    return () => {
      current = false;
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [path]);

  if (!state) return <ViewerLoading label="Preparing spreadsheet…" />;
  if ("message" in state) {
    return (
      <ViewerMessage title={state.message} detail={fileNameOf(path)}>
        <OpenWith path={path} />
      </ViewerMessage>
    );
  }
  const sheet = state.sheets[Math.min(active, state.sheets.length - 1)];
  if (!sheet) return <ViewerMessage title="This file is empty." />;

  return (
    <>
      {sheet.rows.length >= MAX_ROWS ? <ViewerBanner>Showing the first part of this sheet.</ViewerBanner> : null}
      <CsvTable rows={sheet.rows} letters />
      <div
        role="tablist"
        aria-label="Sheets"
        style={tabs}
        // Left/Right/Home/End move to a sheet and open it.
        onKeyDown={(event) => {
          const next = rovingKeyDown(event, '[role="tab"]', "horizontal");
          if (next?.dataset.index !== undefined) setActive(Number(next.dataset.index));
        }}
      >
        {state.sheets.map((s, index) => (
          <button
            key={`${index}-${s.name}`}
            type="button"
            role="tab"
            data-index={index}
            aria-selected={index === active}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            style={{ ...tab, ...(index === active ? tabActive : null) }}
          >
            {s.name}
          </button>
        ))}
      </div>
    </>
  );
}

const tabs: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "6px 12px",
  borderTop: "1px solid var(--rb-line)",
  background: "var(--rb-surface)",
  overflowX: "auto",
};

const tab: CSSProperties = {
  padding: "4px 12px",
  border: 0,
  borderRadius: 8,
  background: "transparent",
  color: "var(--rb-muted)",
  font: "inherit",
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const tabActive: CSSProperties = {
  background: "var(--rb-accent-soft)",
  color: "var(--rb-accent-text)",
  fontWeight: 600,
};
