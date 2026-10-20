import type { CSSProperties } from "react";
import IconAltArrowRight from "~icons/solar/alt-arrow-right-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";

export interface BreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  /** The folder a drag would land in, to highlight it. */
  dropTarget: string | null;
}

export function Breadcrumbs({ currentPath, onNavigate, dropTarget }: BreadcrumbsProps) {
  const parts = currentPath.split("/").filter(Boolean);
  const crumbs = [
    { label: "All files", path: "" },
    ...parts.map((part, idx) => ({
      label: part,
      path: parts.slice(0, idx + 1).join("/"),
    })),
  ];

  return (
    <nav aria-label="Breadcrumb" style={container}>
      <ol style={list}>
        {crumbs.map((crumb, idx) => {
          const isLast = idx === crumbs.length - 1;
          const isDropActive = dropTarget === crumb.path;

          return (
            <li key={crumb.path || "root"} style={item}>
              {idx > 0 ? (
                <span aria-hidden style={separator}>
                  <IconAltArrowRight width={12} height={12} />
                </span>
              ) : null}

              {isLast ? (
                <span
                  aria-current="location"
                  data-drop-dir={crumb.path}
                  style={{
                    ...crumbText,
                    fontWeight: 600,
                    color: "var(--rb-ink)",
                    background: isDropActive ? "var(--rb-accent-soft)" : "transparent",
                  }}
                >
                  {idx === 0 ? <IconFolder width={16} height={16} style={{ display: "inline-flex" }} /> : null}
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(crumb.path)}
                  data-drop-dir={crumb.path}
                  style={{
                    ...crumbButton,
                    background: isDropActive ? "var(--rb-accent-soft)" : "transparent",
                  }}
                >
                  {idx === 0 ? <IconFolder width={16} height={16} style={{ display: "inline-flex" }} /> : null}
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const container: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
};

const list: CSSProperties = {
  display: "flex",
  alignItems: "center",
  listStyle: "none",
  margin: 0,
  padding: 0,
  gap: 4,
  flexWrap: "wrap",
};

const item: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const separator: CSSProperties = {
  display: "flex",
  alignItems: "center",
  color: "var(--rb-muted)",
};

const crumbButton: CSSProperties = {
  border: 0,
  borderRadius: 6,
  padding: "3px 6px",
  cursor: "pointer",
  color: "var(--rb-muted)",
  font: "inherit",
  fontSize: 13.5,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  transition: "color 0.15s ease, background 0.15s ease",
};

const crumbText: CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  fontSize: 13.5,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};
