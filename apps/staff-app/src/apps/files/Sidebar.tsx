import type { CSSProperties, ReactNode } from "react";
import { ProgressBar } from "@rulebox/ui";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconFolderSelected from "~icons/solar/folder-bold";
import IconDocument from "~icons/solar/document-bold-duotone";
import IconDocumentSelected from "~icons/solar/document-bold";
import IconMusicNote from "~icons/solar/music-note-bold-duotone";
import IconMusicNoteSelected from "~icons/solar/music-note-bold";
import IconVideo from "~icons/solar/videocamera-bold-duotone";
import IconVideoSelected from "~icons/solar/videocamera-bold";
import IconGallery from "~icons/solar/gallery-bold-duotone";
import IconGallerySelected from "~icons/solar/gallery-bold";
import IconDownload from "~icons/solar/download-bold-duotone";
import IconDownloadSelected from "~icons/solar/download-bold";
import IconTrash from "~icons/solar/trash-bin-trash-bold-duotone";
import IconTrashSelected from "~icons/solar/trash-bin-trash-bold";
import IconDanger from "~icons/solar/danger-triangle-bold-duotone";

import type { StorageThresholdResult } from "./storage";
import type { SidebarSection } from "./types";

export interface SidebarProps {
  section: SidebarSection;
  onSelectSection: (section: SidebarSection) => void;
  storage: StorageThresholdResult;
  /** The folder a drag would land in, to highlight it. */
  dropTarget: string | null;
  /** The storage bar's Free up space action. */
  onFreeUp: () => void;
  /** A narrow window: icons only, names in tooltips. */
  compact?: boolean;
}

interface SectionItem {
  id: SidebarSection;
  label: string;
  targetDir?: string;
  icon: (active: boolean) => ReactNode;
}

const SECTIONS: SectionItem[] = [
  {
    id: "all",
    label: "All files",
    targetDir: "",
    icon: (active) =>
      active ? <IconFolderSelected width={18} height={18} /> : <IconFolder width={18} height={18} />,
  },
  {
    id: "documents",
    label: "Documents",
    icon: (active) =>
      active ? <IconDocumentSelected width={18} height={18} /> : <IconDocument width={18} height={18} />,
  },
  {
    id: "audio",
    label: "Audio",
    icon: (active) =>
      active ? <IconMusicNoteSelected width={18} height={18} /> : <IconMusicNote width={18} height={18} />,
  },
  {
    id: "video",
    label: "Video",
    icon: (active) =>
      active ? <IconVideoSelected width={18} height={18} /> : <IconVideo width={18} height={18} />,
  },
  {
    id: "images",
    label: "Images",
    icon: (active) =>
      active ? <IconGallerySelected width={18} height={18} /> : <IconGallery width={18} height={18} />,
  },
  {
    id: "downloads",
    label: "Downloads",
    targetDir: "Downloads",
    icon: (active) =>
      active ? <IconDownloadSelected width={18} height={18} /> : <IconDownload width={18} height={18} />,
  },
  {
    id: "trash",
    label: "Trash",
    icon: (active) =>
      active ? <IconTrashSelected width={18} height={18} /> : <IconTrash width={18} height={18} />,
  },
];

export function Sidebar({ section, onSelectSection, storage, dropTarget, onFreeUp, compact = false }: SidebarProps) {
  return (
    <aside
      aria-label="Files navigation"
      style={{
        width: compact ? 60 : 210,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: compact ? "12px 8px" : "16px 12px",
        background: "var(--rb-surface)",
        borderRight: "1px solid var(--rb-line)",
        userSelect: "none",
        minHeight: 0,
      }}
    >
      <nav style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {SECTIONS.map((item) => {
          const active = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              data-drop-dir={item.targetDir}
              aria-current={active ? "page" : undefined}
              aria-label={compact ? item.label : undefined}
              title={compact ? item.label : undefined}
              style={{
                ...navButton,
                justifyContent: compact ? "center" : "flex-start",
                padding: compact ? "10px 0" : navButton.padding,
                background: active || (item.targetDir !== undefined && dropTarget === item.targetDir) ? "var(--rb-accent-soft)" : "transparent",
                color: active ? "var(--rb-accent-text)" : "var(--rb-ink)",
                fontWeight: active ? 600 : 500,
              }}
            >
              <span
                style={{
                  display: "flex",
                  color: active ? "var(--rb-accent)" : "var(--rb-muted)",
                }}
              >
                {item.icon(active)}
              </span>
              {compact ? null : <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {compact ? (
        <div style={storageSection} title={`Storage: ${storage.detail}`}>
          <ProgressBar value={storage.pct} name={`Storage: ${storage.detail}`} />
        </div>
      ) : (
      <div style={storageSection}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--rb-ink)" }}>Storage</span>
          {storage.actionText ? (
            <button
              type="button"
              onClick={onFreeUp}
              style={{
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                padding: 0,
                border: 0,
                background: "transparent",
                cursor: "pointer",
                font: "inherit",
                color: storage.tone === "danger" ? "var(--rb-danger-text)" : "var(--rb-warning-text)",
                fontWeight: 600,
              }}
            >
              <IconDanger width={12} height={12} />
              {storage.actionText}
            </button>
          ) : null}
        </div>

        <ProgressBar value={storage.pct} name="Storage" detail={storage.detail} />

        {storage.banner ? (
          <div
            role="alert"
            style={{
              marginTop: 8,
              padding: "6px 8px",
              borderRadius: 8,
              background: "var(--rb-danger-soft)",
              color: "var(--rb-danger-text)",
              fontSize: 11.5,
              fontWeight: 500,
              lineHeight: 1.3,
            }}
          >
            {storage.banner}
          </div>
        ) : null}
      </div>
      )}
    </aside>
  );
}

const navButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "8px 10px",
  borderRadius: 10,
  border: 0,
  fontSize: 13.5,
  fontFamily: "inherit",
  cursor: "pointer",
  textAlign: "left",
  transition: "background 0.15s ease, color 0.15s ease",
};

const storageSection: CSSProperties = {
  paddingTop: 12,
  borderTop: "1px solid var(--rb-line)",
};
