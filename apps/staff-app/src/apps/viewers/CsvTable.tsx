import { useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { columnCount, columnLetter } from "./tableLogic";
import { ViewerMessage } from "./ViewerMessage";

const ROW_HEIGHT = 30;
const COLUMN_WIDTH = 160;
const NUMBER_WIDTH = 56;

/**
 * A virtualised table. Every cell is a text node: a value like `=cmd|' /C calc'!A0`
 * is shown as those characters and never evaluated or turned into a link.
 * `letters` adds the A, B, C... header a spreadsheet has.
 */
export function CsvTable({ rows, letters = false }: { rows: string[][]; letters?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = columnCount(rows);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual, used as the plan says
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  if (rows.length === 0) {
    return <ViewerMessage title="This file is empty." />;
  }
  const width = NUMBER_WIDTH + columns * COLUMN_WIDTH;

  return (
    <div
      ref={scrollRef}
      // A read-only table (no cell editing, no cell-by-cell arrow keys), so not a grid.
      // It takes focus so the arrow keys, Page Up/Down and Home/End scroll it.
      role="table"
      aria-label="Table"
      aria-rowcount={rows.length}
      aria-colcount={columns}
      tabIndex={0}
      className="rb-focus-inset"
      style={scroller}
    >
      {letters ? (
        <div aria-hidden style={{ ...letterRow, width }}>
          <div style={numberCell} />
          {Array.from({ length: columns }, (_, column) => (
            <div key={column} style={{ ...cell, justifyContent: "center", color: "var(--rb-muted)" }}>
              {columnLetter(column)}
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ height: virtualizer.getTotalSize(), width, position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index] ?? [];
          return (
            <div
              key={item.index}
              role="row"
              aria-rowindex={item.index + 1}
              style={{
                ...rowStyle,
                width,
                transform: `translateY(${item.start}px)`,
                fontWeight: !letters && item.index === 0 ? 600 : 400,
              }}
            >
              <div aria-hidden style={numberCell}>
                {item.index + 1}
              </div>
              {Array.from({ length: columns }, (_, column) => (
                <div role="cell" key={column} style={cell} title={row[column] ?? ""}>
                  {row[column] ?? ""}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const letterRow: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  height: ROW_HEIGHT,
  display: "flex",
  background: "var(--rb-bg)",
  borderBottom: "1px solid var(--rb-line)",
};

const scroller: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  background: "var(--rb-surface)",
  color: "var(--rb-ink)",
  fontSize: 13,
};

const rowStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  height: ROW_HEIGHT,
  display: "flex",
  borderBottom: "1px solid var(--rb-line)",
};

const numberCell: CSSProperties = {
  width: NUMBER_WIDTH,
  flexShrink: 0,
  padding: "0 10px",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  color: "var(--rb-muted)",
  background: "var(--rb-bg)",
  borderRight: "1px solid var(--rb-line)",
};

const cell: CSSProperties = {
  width: COLUMN_WIDTH,
  flexShrink: 0,
  padding: "0 10px",
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  borderRight: "1px solid var(--rb-line)",
};
