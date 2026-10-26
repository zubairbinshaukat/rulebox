import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileChip } from "@rulebox/ui";
import type { Entry } from "@rulebox/types";
import IconFolder from "~icons/solar/folder-bold-duotone";

import { RenameInput } from "./RenameInput";
import {
  GRID_GAP,
  GRID_ITEM_MIN_WIDTH,
  GRID_ROW_HEIGHT,
  GRID_SIDE_PADDING,
  gridColumnsFor,
} from "./layout";
import { getExtension, itemId } from "./utils";

export interface FileGridProps {
  items: Entry[];
  selected: ReadonlySet<string>;
  cut: ReadonlySet<string>;
  focusedPath: string | null;
  renamingPath: string | null;
  dropTarget: string | null;
  /** Reported whenever the number of columns changes (arrow keys need it). */
  onColumns: (columns: number) => void;
  onItemClick: (path: string, event: MouseEvent) => void;
  onItemDoubleClick: (entry: Entry) => void;
  onItemContextMenu: (path: string, event: MouseEvent) => void;
  onItemPointerDown: (entry: Entry, event: PointerEvent) => void;
  onCommitRename: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
}

export function FileGrid({
  items,
  selected,
  cut,
  focusedPath,
  renamingPath,
  dropTarget,
  onColumns,
  onItemClick,
  onItemDoubleClick,
  onItemContextMenu,
  onItemPointerDown,
  onCommitRename,
  onCancelRename,
}: FileGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const next = gridColumnsFor(element.clientWidth);
      setColumns(next);
      onColumns(next);
    };
    // A ResizeObserver reports once as soon as it starts watching.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onColumns]);

  const rowCount = Math.ceil(items.length / columns);
  const focusedIndex = items.findIndex((item) => item.path === focusedPath);
  const focusedRow = focusedIndex >= 0 ? Math.floor(focusedIndex / columns) : -1;

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual, used as the plan says
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 3,
  });

  useEffect(() => {
    if (focusedRow >= 0) {
      virtualizer.scrollToIndex(focusedRow, { align: "auto" });
    }
  }, [focusedRow, virtualizer]);

  // The focused row stays mounted so keyboard focus is never lost.
  const rows = virtualizer.getVirtualItems().map((row) => ({ index: row.index, start: row.start }));
  if (focusedRow >= 0 && focusedRow < rowCount && !rows.some((row) => row.index === focusedRow)) {
    rows.push({ index: focusedRow, start: focusedRow * GRID_ROW_HEIGHT });
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Files"
      aria-multiselectable="true"
      aria-activedescendant={focusedPath ? itemId(focusedPath) : undefined}
      tabIndex={0}
      data-explorer-list
      className="rb-focus-inset"
      style={gridContainer}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {rows.map(({ index, start }) => (
          <div
            key={index}
            role="presentation"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: GRID_ROW_HEIGHT,
              transform: `translateY(${start}px)`,
              display: "grid",
              gridTemplateColumns: `repeat(${columns}, minmax(${GRID_ITEM_MIN_WIDTH}px, 1fr))`,
              gap: GRID_GAP,
              padding: `0 ${GRID_SIDE_PADDING}px ${GRID_GAP}px`,
              boxSizing: "border-box",
            }}
          >
            {items.slice(index * columns, index * columns + columns).map((entry) => {
              const isSelected = selected.has(entry.path);
              const isFocused = focusedPath === entry.path;
              const isFolder = entry.kind === "folder";
              const dropActive = dropTarget === entry.path;
              const ext = getExtension(entry.name);

              return (
                <div
                  key={entry.path}
                  id={itemId(entry.path)}
                  role="option"
                  aria-selected={isSelected}
                  data-drop-dir={isFolder ? entry.path : undefined}
                  onPointerDown={(event) => onItemPointerDown(entry, event)}
                  onClick={(event) => onItemClick(entry.path, event)}
                  onDoubleClick={() => onItemDoubleClick(entry)}
                  onContextMenu={(event) => onItemContextMenu(entry.path, event)}
                  style={{
                    ...gridCard,
                    background: dropActive || isSelected ? "var(--rb-accent-soft)" : "var(--rb-surface)",
                    // Selected and focused cards get a 2 px line, not only a tint.
                    border: `${isSelected || dropActive || isFocused ? 2 : 1}px solid ${
                      dropActive || isFocused ? "var(--rb-focus)" : isSelected ? "var(--rb-accent)" : "var(--rb-line)"
                    }`,
                    opacity: cut.has(entry.path) ? 0.5 : 1,
                  }}
                >
                  <div style={iconContainer} aria-hidden="true">
                    {isFolder ? (
                      <IconFolder width={42} height={42} style={{ color: "var(--rb-accent)" }} />
                    ) : (
                      <FileChip ext={ext} style={{ transform: "scale(1.15)" }} />
                    )}
                  </div>
                  {renamingPath === entry.path ? (
                    <RenameInput
                      centered
                      initialName={entry.name}
                      onCommit={(name) => onCommitRename(entry.path, name)}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <span title={entry.path} style={nameLabel}>
                      {entry.name}
                      {isFolder ? <span className="rb-sr-only">, folder</span> : null}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const gridContainer: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  paddingTop: 16,
  userSelect: "none",
};

const gridCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 10,
  borderRadius: 12,
  cursor: "default",
  minHeight: 110,
  boxSizing: "border-box",
};

const iconContainer: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 52,
  marginBottom: 8,
};

const nameLabel: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  textAlign: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  wordBreak: "break-word",
  lineHeight: 1.3,
  width: "100%",
};
