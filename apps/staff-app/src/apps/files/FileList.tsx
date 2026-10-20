import { useEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileChip } from "@rulebox/ui";
import type { Entry } from "@rulebox/types";
import IconFolder from "~icons/solar/folder-bold-duotone";

import { LIST_ROW_HEIGHT } from "./layout";
import { RenameInput } from "./RenameInput";
import type { SortConfig, SortField } from "./types";
import { formatBytes, formatDate, getExtension, itemId } from "./utils";

export interface FileListProps {
  items: Entry[];
  selected: ReadonlySet<string>;
  /** Paths on the clipboard to be moved: shown dimmed. */
  cut: ReadonlySet<string>;
  focusedPath: string | null;
  sort: SortConfig;
  renamingPath: string | null;
  /** The folder a drag would land in, to highlight it. */
  dropTarget: string | null;
  onSortChange: (field: SortField) => void;
  onItemClick: (path: string, event: MouseEvent) => void;
  onItemDoubleClick: (entry: Entry) => void;
  onItemContextMenu: (path: string, event: MouseEvent) => void;
  onItemPointerDown: (entry: Entry, event: PointerEvent) => void;
  onCommitRename: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
}

const COLUMNS: { field: SortField; label: string; style: CSSProperties }[] = [
  { field: "name", label: "Name", style: { flex: 1, minWidth: 0 } },
  { field: "type", label: "Type", style: { width: 110 } },
  { field: "size", label: "Size", style: { width: 100, textAlign: "right" } },
  { field: "modified", label: "Date modified", style: { width: 170, textAlign: "right" } },
];

export function FileList({
  items,
  selected,
  cut,
  focusedPath,
  sort,
  renamingPath,
  dropTarget,
  onSortChange,
  onItemClick,
  onItemDoubleClick,
  onItemContextMenu,
  onItemPointerDown,
  onCommitRename,
  onCancelRename,
}: FileListProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual, used as the plan says
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => LIST_ROW_HEIGHT,
    overscan: 8,
  });

  const focusedIndex = items.findIndex((item) => item.path === focusedPath);

  useEffect(() => {
    if (focusedIndex >= 0) {
      virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
    }
  }, [focusedIndex, virtualizer]);

  // The focused row stays mounted even when it has scrolled out of the window,
  // so keyboard focus is never lost.
  const rows = virtualizer.getVirtualItems().map((row) => ({ index: row.index, start: row.start }));
  if (focusedIndex >= 0 && !rows.some((row) => row.index === focusedIndex)) {
    rows.push({ index: focusedIndex, start: focusedIndex * LIST_ROW_HEIGHT });
  }

  return (
    <div
      role="grid"
      aria-label="Files"
      aria-rowcount={items.length + 1}
      aria-colcount={4}
      aria-multiselectable="true"
      aria-activedescendant={focusedPath ? itemId(focusedPath) : undefined}
      tabIndex={0}
      data-explorer-list
      style={tableContainer}
    >
      <div role="row" aria-rowindex={1} style={headerRow}>
        {COLUMNS.map((column) => {
          const active = sort.field === column.field;
          return (
            <div
              key={column.field}
              role="columnheader"
              aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
              onClick={() => onSortChange(column.field)}
              style={{ ...column.style, cursor: "pointer" }}
            >
              {column.label} {active ? (sort.direction === "asc" ? "▲" : "▼") : null}
            </div>
          );
        })}
      </div>

      <div ref={bodyRef} style={bodyContainer}>
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {rows.map(({ index, start }) => {
            const entry = items[index];
            if (!entry) {
              return null;
            }
            const isSelected = selected.has(entry.path);
            const isFocused = focusedPath === entry.path;
            const isFolder = entry.kind === "folder";
            const ext = getExtension(entry.name);
            const dropActive = dropTarget === entry.path;

            return (
              <div
                key={entry.path}
                id={itemId(entry.path)}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={isSelected}
                data-drop-dir={isFolder ? entry.path : undefined}
                onPointerDown={(event) => onItemPointerDown(entry, event)}
                onClick={(event) => onItemClick(entry.path, event)}
                onDoubleClick={() => onItemDoubleClick(entry)}
                onContextMenu={(event) => onItemContextMenu(entry.path, event)}
                style={{
                  ...itemRow,
                  height: LIST_ROW_HEIGHT,
                  transform: `translateY(${start}px)`,
                  background: dropActive || isSelected ? "var(--rb-accent-soft)" : "transparent",
                  outline: dropActive
                    ? "2px solid var(--rb-accent)"
                    : isFocused
                      ? "1px solid var(--rb-accent)"
                      : "none",
                  outlineOffset: -1,
                  opacity: cut.has(entry.path) ? 0.5 : 1,
                }}
              >
                <div role="gridcell" style={{ ...cell, flex: 1, minWidth: 0 }}>
                  <span style={iconWrapper}>
                    {isFolder ? (
                      <IconFolder width={18} height={18} style={{ color: "var(--rb-accent)" }} />
                    ) : (
                      <FileChip ext={ext} />
                    )}
                  </span>
                  {renamingPath === entry.path ? (
                    <RenameInput
                      initialName={entry.name}
                      onCommit={(name) => onCommitRename(entry.path, name)}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <span style={nameText} title={entry.path}>
                      {entry.name}
                    </span>
                  )}
                </div>
                <div role="gridcell" style={{ ...cell, width: 110, color: "var(--rb-muted)" }}>
                  {isFolder ? "Folder" : ext.toUpperCase() || "File"}
                </div>
                <div
                  role="gridcell"
                  style={{ ...cell, width: 100, justifyContent: "flex-end", color: "var(--rb-muted)" }}
                >
                  {isFolder ? "" : formatBytes(entry.size)}
                </div>
                <div
                  role="gridcell"
                  style={{ ...cell, width: 170, justifyContent: "flex-end", color: "var(--rb-muted)" }}
                >
                  {formatDate(entry.modifiedMs)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const tableContainer: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  outline: "none",
  userSelect: "none",
};

const headerRow: CSSProperties = {
  display: "flex",
  // Same scrollbar gutter as the body, so the columns line up with the rows.
  overflow: "hidden",
  scrollbarGutter: "stable",
  padding: "8px 16px",
  borderBottom: "1px solid var(--rb-line)",
  color: "var(--rb-muted)",
  fontSize: 12,
  fontWeight: 600,
};

const bodyContainer: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  scrollbarGutter: "stable",
};

const itemRow: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  borderBottom: "1px solid var(--rb-line)",
  fontSize: 13,
  cursor: "default",
};

const cell: CSSProperties = {
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const iconWrapper: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  marginRight: 10,
  flexShrink: 0,
};

const nameText: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontWeight: 500,
};
