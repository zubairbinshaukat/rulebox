import { Button } from "@rulebox/ui";
import { useState } from "react";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconGallery from "~icons/solar/gallery-bold-duotone";

type Tab = "all" | "docs" | "media";

const SAMPLE = [
  { id: "1", name: "Shift notes.txt", kind: "docs" as const, when: "Yesterday" },
  { id: "2", name: "Order photo.jpg", kind: "media" as const, when: "Mon" },
  { id: "3", name: "Checklist.pdf", kind: "docs" as const, when: "Mon" },
  { id: "4", name: "Welcome clip.mp4", kind: "media" as const, when: "Last week" },
];

/**
 * Static recent-files list until Step 13 fills it from the SafeRoot.
 * Hidden by the parent when the desktop is narrower than 1000 px.
 */
export function MyFilesPanel({ onOpenFiles }: { onOpenFiles?: () => void }) {
  const [tab, setTab] = useState<Tab>("all");
  const items = SAMPLE.filter((f) => tab === "all" || f.kind === tab);

  return (
    <aside
      data-testid="my-files-panel"
      style={{
        width: 300,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        borderRadius: 20,
        background: "var(--rb-surface)",
        border: "1px solid var(--rb-line)",
        color: "var(--rb-ink)",
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <IconFolder width={20} height={20} />
        <span style={{ fontWeight: 500, fontSize: 15 }}>My files</span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {(
          [
            ["all", "All"],
            ["docs", "Docs"],
            ["media", "Media"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              flex: 1,
              padding: "6px 8px",
              borderRadius: 10,
              border: 0,
              cursor: "pointer",
              fontSize: 13,
              background: tab === id ? "var(--rb-accent-soft)" : "transparent",
              color: tab === id ? "var(--rb-accent-text)" : "var(--rb-muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flex: 1,
          overflow: "auto",
        }}
      >
        {items.map((file) => (
          <li
            key={file.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 12,
              background: "var(--rb-bg)",
            }}
          >
            {file.kind === "media" ? (
              <IconGallery width={18} height={18} />
            ) : (
              <IconDocument width={18} height={18} />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.name}
              </div>
              <div style={{ fontSize: 12, color: "var(--rb-muted)" }}>{file.when}</div>
            </div>
          </li>
        ))}
      </ul>
      <Button type="button" onClick={() => onOpenFiles?.()}>
        Open Files
      </Button>
    </aside>
  );
}
