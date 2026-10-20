import { useState, type FormEvent } from "react";
import { Button, Dialog, Input } from "@rulebox/ui";
import IconDanger from "~icons/solar/danger-triangle-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";

import type { DialogState } from "./types";
import { validateName } from "./validation";

export interface DialogsProps {
  dialog: DialogState;
  onClose: () => void;
  onConfirmDelete: (items: { name: string; path: string }[], permanent: boolean) => void;
  onCreateFolder: (name: string) => void;
}

export function Dialogs({ dialog, onClose, onConfirmDelete, onCreateFolder }: DialogsProps) {
  if (dialog.type === "none") {
    return null;
  }

  if (dialog.type === "confirmDelete") {
    const isSingle = dialog.items.length === 1;
    const title = dialog.permanent ? "Permanently delete?" : "Move to trash?";
    const body = dialog.permanent
      ? isSingle
        ? `Are you sure you want to permanently delete "${dialog.items[0]?.name}"? This cannot be undone.`
        : `Are you sure you want to permanently delete ${dialog.items.length} items? This cannot be undone.`
      : isSingle
        ? `Move "${dialog.items[0]?.name}" to the trash?`
        : `Move ${dialog.items.length} items to the trash?`;

    return (
      <Dialog open title={title} onClose={onClose}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 20 }}>
          <span style={{ color: "var(--rb-danger)", display: "flex", marginTop: 2 }}>
            <IconDanger width={24} height={24} />
          </span>
          <p style={{ margin: 0, fontSize: 14, color: "var(--rb-muted)", lineHeight: 1.45 }}>{body}</p>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger-ghost"
            type="button"
            autoFocus
            onClick={() => {
              onClose();
              onConfirmDelete(dialog.items, dialog.permanent);
            }}
          >
            {dialog.permanent ? "Delete permanently" : "Move to trash"}
          </Button>
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "blocked") {
    return (
      <Dialog open title="Blocked file type" onClose={onClose}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 20 }}>
          <span style={{ color: "var(--rb-danger)", display: "flex", marginTop: 2 }}>
            <IconDanger width={24} height={24} />
          </span>
          <p style={{ margin: 0, fontSize: 14, color: "var(--rb-ink)", lineHeight: 1.45 }}>
            This type of file can't be opened on this PC.
          </p>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="primary" type="button" autoFocus onClick={onClose}>
            OK
          </Button>
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "noHandler") {
    const ext = dialog.extension ? `.${dialog.extension}` : "this type of";
    return (
      <Dialog open title="No app available" onClose={onClose}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 20 }}>
          <span style={{ color: "var(--rb-muted)", display: "flex", marginTop: 2 }}>
            <IconFolder width={24} height={24} />
          </span>
          <p style={{ margin: 0, fontSize: 14, color: "var(--rb-ink)", lineHeight: 1.45 }}>
            No app on this PC can open {ext} files.
          </p>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="primary" type="button" autoFocus onClick={onClose}>
            OK
          </Button>
        </div>
      </Dialog>
    );
  }

  if (dialog.type === "newFolder") {
    return <NewFolderModal defaultName={dialog.defaultName} onClose={onClose} onCreate={onCreateFolder} />;
  }

  if (dialog.type === "error") {
    return (
      <Dialog open title={dialog.title} onClose={onClose}>
        <p style={{ margin: "0 0 20px", fontSize: 14, color: "var(--rb-muted)", lineHeight: 1.45 }}>
          {dialog.message}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="primary" type="button" autoFocus onClick={onClose}>
            OK
          </Button>
        </div>
      </Dialog>
    );
  }

  return null;
}

function NewFolderModal({
  defaultName,
  onClose,
  onCreate,
}: {
  defaultName: string;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const validation = validateName(name);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (validation.valid) {
      onClose();
      onCreate(name);
    }
  }

  return (
    <Dialog open title="New folder" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 16 }}>
          <Input
            autoFocus
            aria-label="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: "100%" }}
          />
          {!validation.valid && validation.message ? (
            <p
              role="alert"
              style={{
                margin: "6px 0 0",
                fontSize: 12,
                color: "var(--rb-danger-text)",
                fontWeight: 500,
              }}
            >
              {validation.message}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!validation.valid}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
