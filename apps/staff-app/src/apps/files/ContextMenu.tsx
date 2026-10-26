import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import IconAddFolder from "~icons/solar/add-folder-bold-duotone";
import IconClipboard from "~icons/solar/clipboard-list-bold-duotone";
import IconCopy from "~icons/solar/copy-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconPen from "~icons/solar/pen-bold-duotone";
import IconScissors from "~icons/solar/scissors-bold-duotone";
import IconTrash from "~icons/solar/trash-bin-trash-bold-duotone";

export interface ContextMenuProps {
  x: number;
  y: number;
  hasTarget: boolean;
  canPaste: boolean;
  openWithApp?: string | null;
  onOpen: () => void;
  onOpenWith?: () => void;
  onRename: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onTrash: () => void;
  onNewFolder: () => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  hasTarget,
  canPaste,
  openWithApp,
  onOpen,
  onOpenWith,
  onRename,
  onCopy,
  onCut,
  onPaste,
  onTrash,
  onNewFolder,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // The parent passes a new onClose on every render; the menu must not refocus because of that.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();

    function handlePointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeRef.current();
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      // Back to the list, so the keyboard carries on where it was.
      previous?.focus?.();
    };
  }, []);

  /** Arrow keys move through the items; Escape closes. Nothing leaks to the explorer. */
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    const count = items.length;
    const target: Record<string, number> = {
      ArrowDown: (at + 1) % count,
      ArrowUp: (at - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const next = target[e.key];
    if (next === undefined || count === 0) {
      // Any other key belongs to the menu, not to the explorer behind it.
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();    items[next]?.focus();
  }
  // Clamp within viewport
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 280);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="File context menu"
      onKeyDown={handleKeyDown}
      style={{
        ...menuContainer,
        left: Math.max(8, left),
        top: Math.max(8, top),
      }}
    >
      {hasTarget ? (
        <>
          <ContextMenuItem
            icon={<IconFolder width={16} height={16} />}
            label="Open"
            shortcut="Enter"
            onClick={() => {
              onClose();
              onOpen();
            }}
          />
          {openWithApp ? (
            <ContextMenuItem
              icon={<IconFolder width={16} height={16} />}
              label={`Open with ${openWithApp}`}
              onClick={() => {
                onClose();
                onOpenWith?.();
              }}
            />
          ) : null}
          <div role="separator" style={divider} />
          <ContextMenuItem
            icon={<IconPen width={16} height={16} />}
            label="Rename"
            shortcut="F2"
            onClick={() => {
              onClose();
              onRename();
            }}
          />
          <ContextMenuItem
            icon={<IconCopy width={16} height={16} />}
            label="Copy"
            shortcut="Ctrl+C"
            onClick={() => {
              onClose();
              onCopy();
            }}
          />
          <ContextMenuItem
            icon={<IconScissors width={16} height={16} />}
            label="Cut"
            shortcut="Ctrl+X"
            onClick={() => {
              onClose();
              onCut();
            }}
          />
        </>
      ) : null}

      <ContextMenuItem
        icon={<IconClipboard width={16} height={16} />}
        label="Paste"
        shortcut="Ctrl+V"
        disabled={!canPaste}
        onClick={() => {
          onClose();
          onPaste();
        }}
      />

      <div role="separator" style={divider} />

      {hasTarget ? (
        <ContextMenuItem
          icon={<IconTrash width={16} height={16} />}
          label="Move to trash"
          shortcut="Del"
          onClick={() => {
            onClose();
            onTrash();
          }}
        />
      ) : null}

      <ContextMenuItem
        icon={<IconAddFolder width={16} height={16} />}
        label="New folder"
        shortcut="Ctrl+Shift+N"
        onClick={() => {
          onClose();
          onNewFolder();
        }}
      />
    </div>
  );
}

function ContextMenuItem({
  icon,
  label,
  shortcut,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="rb-ctx-item"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...menuItem,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <span aria-hidden="true" style={{ display: "flex", color: "var(--rb-muted)" }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {shortcut ? (
        <span style={{ fontSize: 11, color: "var(--rb-muted)", marginLeft: 16 }}>{shortcut}</span>
      ) : null}
    </button>
  );
}

const menuContainer: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  minWidth: 185,
  background: "var(--rb-surface)",
  border: "1px solid var(--rb-line)",
  borderRadius: 12,
  boxShadow: "var(--rb-shadow-md)",
  padding: 6,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  userSelect: "none",
};

const menuItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 8px",
  borderRadius: 8,
  border: 0,
  color: "var(--rb-ink)",
  font: "inherit",
  fontSize: 13,
  textAlign: "left",
  transition: "background 0.12s ease",
};

const divider: CSSProperties = {
  height: 1,
  background: "var(--rb-line)",
  margin: "4px 2px",
};
