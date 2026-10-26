import { useEffect, useRef, useState } from "react";
import { Button, FileChip } from "@rulebox/ui";
import type { Entry, FileKind } from "@rulebox/types";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconGallery from "~icons/solar/gallery-bold-duotone";

import { useTauriEvent } from "../../lib/events";
import { openFile } from "../../lib/files";
import { call, isTauri } from "../../lib/tauri";

type Tab = "all" | "docs" | "media";

const MEDIA_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "mp3", "wav", "m4a", "mp4", "webm"]);

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function formatWhen(ms: number): string {
  if (!ms || ms <= 0) {
    return "Recently";
  }
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Each tab asks the backend for the newest files of its kind in every folder. */
const TAB_KIND: Record<Tab, FileKind> = { all: "all", docs: "documents", media: "media" };
const PANEL_LIMIT = 12;
/** A burst of file changes (a copy of many files) is one reload. */
const RELOAD_DELAY_MS = 400;

export function MyFilesPanel({ onOpenFiles }: { onOpenFiles?: () => void }) {
  const [tab, setTab] = useState<Tab>("all");
  const [items, setItems] = useState<Entry[]>([]);
  const [tick, setTick] = useState(0);
  const reloadTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let current = true;
    async function run() {
      if (!isTauri()) {
        return;
      }
      try {
        // Newest first, from every folder: a file Notepad saved in Documents shows up too.
        const list = await call("fs_files", { kind: TAB_KIND[tab], limit: PANEL_LIMIT });
        if (current) setItems(list);
      } catch {
        // The folder may not be open yet.
      }
    }
    void run();
    return () => {
      current = false;
    };
  }, [tab, tick]);

  useEffect(() => () => window.clearTimeout(reloadTimer.current), []);

  // Any change anywhere in the folder can change the newest files.
  useTauriEvent<{ dir: string }>("files://changed", () => {
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => setTick((n) => n + 1), RELOAD_DELAY_MS);
  });

  async function handleOpenFile(file: Entry) {
    try {
      await openFile(file.path);
    } catch {
      // The notice for a failure comes from the backend.
    }
  }

  return (
    <aside
      data-testid="my-files-panel"
      aria-labelledby="my-files-title"
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
        <IconFolder width={20} height={20} aria-hidden />
        <h2 id="my-files-title" style={{ margin: 0, fontWeight: 500, fontSize: 15 }}>
          My files
        </h2>
      </div>
      <div role="group" aria-label="Show" style={{ display: "flex", gap: 6 }}>
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
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            style={{
              flex: 1,
              padding: "6px 8px",
              borderRadius: 10,
              border: 0,
              cursor: "pointer",
              fontSize: 13,
              // Bold as well as tinted, so the chosen filter is not told by colour alone.
              fontWeight: tab === id ? 600 : 400,
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
        {items.length === 0 ? (
          <li style={{ padding: "16px 8px", textAlign: "center", color: "var(--rb-muted)", fontSize: 13 }}>
            No files in this category yet.
          </li>
        ) : (
          items.map((file) => {
            const ext = getExt(file.name);
            const isMedia = MEDIA_EXT.has(ext);

            return (
              <li key={file.path} style={{ listStyle: "none" }}>
              <button
                type="button"
                onClick={() => void handleOpenFile(file)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "8px 10px",
                  border: 0,
                  borderRadius: 12,
                  background: "var(--rb-bg)",
                  color: "inherit",
                  font: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {isMedia ? (
                  <IconGallery width={18} height={18} style={{ color: "var(--rb-accent)", flexShrink: 0 }} />
                ) : ext ? (
                  <FileChip ext={ext} style={{ flexShrink: 0 }} aria-hidden />
                ) : (
                  <IconDocument width={18} height={18} style={{ color: "var(--rb-muted)", flexShrink: 0 }} />
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
                  <div style={{ fontSize: 12, color: "var(--rb-muted)" }}>
                    {formatWhen(file.modifiedMs)}
                  </div>
                </div>
              </button>
              </li>
            );
          })
        )}
      </ul>
      <Button
        type="button"
        onClick={() => {
          if (onOpenFiles) {
            onOpenFiles();
          } else if (isTauri()) {
            void call("open_doc", { kind: "files", path: "" });
          }
        }}
      >
        Open Files
      </Button>
    </aside>
  );
}
