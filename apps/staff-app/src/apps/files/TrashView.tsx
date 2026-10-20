import { useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, FileChip } from "@rulebox/ui";
import type { TrashItem } from "@rulebox/types";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconRestart from "~icons/solar/restart-bold-duotone";
import IconTrash from "~icons/solar/trash-bin-trash-bold-duotone";

import { formatBytes, formatDate, getExtension } from "./utils";

export interface TrashViewProps {
  items: TrashItem[];
  loading: boolean;
  onRestore: (id: string, name: string) => void;
  onPurge: (id: string, name: string) => void;
  onEmptyTrash: () => void;
}

export function TrashView({
  items,
  loading,
  onRestore,
  onPurge,
  onEmptyTrash,
}: TrashViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual, used as the plan says
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 6,
  });

  if (loading) {
    return (
      <div style={emptyContainer}>
        <p style={{ color: "var(--rb-muted)", fontSize: 14 }}>Loading trash…</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={emptyContainer}>
        <IconTrash width={40} height={40} style={{ color: "var(--rb-muted)", opacity: 0.5 }} />
        <p style={{ margin: "12px 0 0", color: "var(--rb-muted)", fontSize: 14 }}>Trash is empty.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={trashHeader}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Trash</span>
          <span style={{ color: "var(--rb-muted)", fontSize: 13, marginLeft: 8 }}>
            ({items.length} {items.length === 1 ? "item" : "items"})
          </span>
        </div>
        <Button variant="danger-ghost" type="button" onClick={onEmptyTrash}>
          Empty trash
        </Button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(200px, 2fr) minmax(140px, 1.5fr) 90px 150px 140px",
          padding: "8px 16px",
          borderBottom: "1px solid var(--rb-line)",
          color: "var(--rb-muted)",
          fontSize: 12,
          fontWeight: 600,
          userSelect: "none",
        }}
      >
        <div>Name</div>
        <div>Original location</div>
        <div style={{ textAlign: "right" }}>Size</div>
        <div style={{ textAlign: "right" }}>Date deleted</div>
        <div style={{ textAlign: "right" }}>Actions</div>
      </div>

      <div
        ref={parentRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          outline: "none",
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) {
              return null;
            }
            const ext = getExtension(item.name);

            return (
              <div
                key={item.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  display: "grid",
                  gridTemplateColumns: "minmax(200px, 2fr) minmax(140px, 1.5fr) 90px 150px 140px",
                  alignItems: "center",
                  padding: "0 16px",
                  borderBottom: "1px solid var(--rb-line)",
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {item.isFolder ? (
                    <IconFolder width={18} height={18} style={{ color: "var(--rb-accent)", flexShrink: 0 }} />
                  ) : (
                    <FileChip ext={ext} style={{ flexShrink: 0 }} />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.name}
                  </span>
                </div>

                <div
                  style={{
                    color: "var(--rb-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.original || "All files"}
                </div>

                <div style={{ textAlign: "right", color: "var(--rb-muted)" }}>
                  {item.isFolder ? "--" : formatBytes(item.size)}
                </div>

                <div style={{ textAlign: "right", color: "var(--rb-muted)" }}>
                  {formatDate(item.deletedMs)}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                  <button
                    type="button"
                    title="Restore"
                    aria-label={`Restore ${item.name}`}
                    onClick={() => onRestore(item.id, item.name)}
                    style={actionButton}
                  >
                    <IconRestart width={14} height={14} />
                    Restore
                  </button>
                  <button
                    type="button"
                    title="Delete permanently"
                    aria-label={`Permanently delete ${item.name}`}
                    onClick={() => onPurge(item.id, item.name)}
                    style={{ ...actionButton, color: "var(--rb-danger-text)" }}
                  >
                    <IconTrash width={14} height={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const emptyContainer: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 32,
};

const trashHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 16px",
  borderBottom: "1px solid var(--rb-line)",
};

const actionButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--rb-line)",
  background: "transparent",
  color: "var(--rb-ink)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};
