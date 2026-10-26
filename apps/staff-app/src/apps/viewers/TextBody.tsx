import { useMemo, useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { splitLines, TEXT_LINE_HEIGHT, WINDOWED_ABOVE_LINES } from "./textLogic";

/**
 * The text itself. Short texts are one block; above 5,000 lines only the rows
 * in view exist. It is always shown as text (`textContent`), never as markup.
 */
export function TextBody({ text }: { text: string }) {
  const lines = useMemo(() => splitLines(text), [text]);
  if (lines.length > WINDOWED_ABOVE_LINES) {
    return <WindowedLines lines={lines} />;
  }
  return (
    <pre tabIndex={0} aria-label="File contents" className="rb-focus-inset" style={block}>
      {text}
    </pre>
  );
}

function WindowedLines({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual, used as the plan says
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TEXT_LINE_HEIGHT,
    overscan: 20,
  });
  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="document"
      aria-label="File contents"
      className="rb-focus-inset"
      style={windowStyle}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: "max-content" }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div key={row.index} style={{ ...lineStyle, transform: `translateY(${row.start}px)` }}>
            {lines[row.index]}
          </div>
        ))}
      </div>
    </div>
  );
}

const mono = "var(--rb-font-mono, 'Geist Mono', ui-monospace, monospace)";

const block: CSSProperties = {
  flex: 1,
  minHeight: 0,
  margin: 0,
  padding: "16px 20px",
  overflow: "auto",
  fontFamily: mono,
  fontSize: 13,
  lineHeight: `${TEXT_LINE_HEIGHT}px`,
  whiteSpace: "pre",
  background: "var(--rb-surface)",
  color: "var(--rb-ink)",
};

const windowStyle: CSSProperties = {
  ...block,
  padding: "16px 0",
  whiteSpace: "normal",
};

const lineStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  height: TEXT_LINE_HEIGHT,
  padding: "0 20px",
  fontFamily: mono,
  fontSize: 13,
  lineHeight: `${TEXT_LINE_HEIGHT}px`,
  whiteSpace: "pre",
};
