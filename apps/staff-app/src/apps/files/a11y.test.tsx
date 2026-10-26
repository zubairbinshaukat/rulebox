import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, TrashItem } from "@rulebox/types";

import { call } from "../../lib/tauri";
import { expectNoAxeViolations } from "../../test/axe";
import { Breadcrumbs } from "./Breadcrumbs";
import { ContextMenu } from "./ContextMenu";
import { Dialogs } from "./Dialogs";
import { FileExplorer } from "./FileExplorer";
import { FileGrid } from "./FileGrid";
import { FileList } from "./FileList";
import { RenameInput } from "./RenameInput";
import { Sidebar } from "./Sidebar";
import { getStorageThreshold } from "./storage";
import { TrashView } from "./TrashView";
import type { DialogState } from "./types";

vi.mock("../../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true }));
vi.mock("../../lib/files", () => ({ openFile: vi.fn(async () => ({ action: "blocked" })) }));
vi.mock("../../lib/events", () => ({ useTauriEvent: () => undefined }));
// jsdom has no layout, so the virtual list would show nothing: render every row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * estimateSize(),
        size: estimateSize(),
        end: (index + 1) * estimateSize(),
        key: index,
        lane: 0,
      })),
    getTotalSize: () => count * estimateSize(),
    scrollToIndex: () => undefined,
  }),
}));

const items: Entry[] = [
  { name: "Docs", path: "Docs", kind: "folder", size: 0, modifiedMs: 1_700_000_000_000 },
  { name: "budget.xlsx", path: "budget.xlsx", kind: "file", size: 2048, modifiedMs: 1_700_000_000_000 },
  { name: "notes.txt", path: "notes.txt", kind: "file", size: 12, modifiedMs: 1_700_000_000_000 },
];

const noop = () => undefined;

function listProps() {
  return {
    items,
    selected: new Set<string>(["notes.txt"]),
    cut: new Set<string>(),
    focusedPath: "budget.xlsx",
    renamingPath: null,
    dropTarget: null,
    onItemClick: noop,
    onItemDoubleClick: noop,
    onItemContextMenu: noop,
    onItemPointerDown: noop,
    onCommitRename: noop,
    onCancelRename: noop,
  };
}

beforeAll(() => {
  // jsdom has none; the grid view measures its width with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(call).mockReset();
});

describe("file list (grid role)", () => {
  it("names the grid, its columns, and each row's selection, and the cursor row is the active descendant", async () => {
    const { container } = render(
      <FileList {...listProps()} sort={{ field: "name", direction: "asc" }} onSortChange={noop} />,
    );
    const grid = screen.getByRole("grid", { name: "Files" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(grid.tabIndex).toBe(0);
    const headers = within(grid).getAllByRole("columnheader");
    expect(headers[0]!.getAttribute("aria-sort")).toBe("ascending");
    expect(headers[1]!.getAttribute("aria-sort")).toBe("none");
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(grid.getAttribute("aria-activedescendant")).toBe(rows[1]!.id);
    // The type badge and icon are decoration: a row reads "budget.xlsx", not "XLSX budget.xlsx".
    expect(rows[1]!.querySelector('[aria-hidden="true"]')).toBeTruthy();
    // The sort arrow is not read out as "up-pointing triangle".
    expect(headers[0]!.querySelector('[aria-hidden="true"]')?.textContent).toBe("▲");
    await expectNoAxeViolations(container);
  });

  it("draws the keyboard cursor with a line (not colour alone) and rings the list when it has the focus", () => {
    render(<FileList {...listProps()} sort={{ field: "name", direction: "asc" }} onSortChange={noop} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[1]!.style.outline).toContain("2px solid");
    expect(rows[0]!.style.outline).toBe("none");
    expect(screen.getByRole("grid").className).toContain("rb-focus-inset");
  });
});

describe("file grid (listbox role)", () => {
  it("is a labelled multi-select listbox of options, with a line on selected cards", async () => {
    const { container } = render(<FileGrid {...listProps()} onColumns={noop} />);
    const box = screen.getByRole("listbox", { name: "Files" });
    expect(box.getAttribute("aria-multiselectable")).toBe("true");
    const options = within(box).getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    // A folder says it is one.
    expect(options[0]!.textContent).toContain("Docs, folder");
    expect(options[2]!.style.border).toContain("2px");
    await expectNoAxeViolations(container);
  });
});

describe("context menu", () => {
  function Host({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>The list</button>
        {open ? (
          <ContextMenu
            x={10}
            y={10}
            hasTarget
            canPaste={false}
            onOpen={noop}
            onRename={noop}
            onCopy={noop}
            onCut={noop}
            onPaste={noop}
            onTrash={noop}
            onNewFolder={noop}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          />
        ) : null}
      </>
    );
  }

  it("is a labelled menu that takes the focus, walks with the arrows, and gives the focus back on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "The list" });
    await user.click(opener);

    const menu = screen.getByRole("menu", { name: "File context menu" });
    const open = within(menu).getByRole("menuitem", { name: /^Open/ });
    expect(document.activeElement).toBe(open);
    // Disabled Paste is skipped by the arrows; the separators are not items.
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: /^New folder/ }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(open);
    await expectNoAxeViolations();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("dialogs", () => {
  function Host({ dialog }: { dialog: DialogState }) {
    return <Dialogs dialog={dialog} onClose={noop} onConfirmDelete={noop} onCreateFolder={noop} />;
  }

  it("asks to confirm a delete as an alert dialog, with the safe button focused first", async () => {
    render(
      <Host dialog={{ type: "confirmDelete", items: [{ name: "budget.xlsx", path: "budget.xlsx" }], permanent: true }} />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Permanently delete?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await expectNoAxeViolations();
  });

  it("labels the new-folder field, and says what is wrong with a name as an alert", async () => {
    const user = userEvent.setup();
    render(<Host dialog={{ type: "newFolder", defaultName: "New folder" }} />);
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    const field = within(dialog).getByLabelText("Folder name");
    expect(document.activeElement).toBe(field);
    await user.clear(field);
    await user.type(field, "bad/name");
    expect((await within(dialog).findByRole("alert")).textContent).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    await expectNoAxeViolations();
  });
});

describe("inline rename", () => {
  it("is a labelled field that marks a bad name invalid and announces why", async () => {
    const user = userEvent.setup();
    const { container } = render(<RenameInput initialName="notes.txt" onCommit={noop} onCancel={noop} />);
    const field = screen.getByLabelText("New name");
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-invalid")).toBe("false");
    await user.clear(field);
    await user.type(field, "a:b");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("Escape cancels without committing", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    render(<RenameInput initialName="notes.txt" onCommit={onCommit} onCancel={onCancel} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("sidebar and breadcrumbs", () => {
  // 85% used: the warning band, with the "Free up space" action.
  const storage = getStorageThreshold(8.5 * 1024 ** 3, 10 * 1024 ** 3);

  it("marks the current place, and names the storage bar", async () => {
    const { container } = render(
      <Sidebar section="documents" onSelectSection={noop} storage={storage} dropTarget={null} onFreeUp={noop} />,
    );
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Documents/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /All files/ }).hasAttribute("aria-current")).toBe(false);
    const bar = screen.getByRole("progressbar", { name: "Storage" });
    expect(bar.getAttribute("aria-valuetext")).toBe("8.5 GB of 10 GB");
    await expectNoAxeViolations(container);
  });

  it("names every button when the sidebar is only icons", async () => {
    const { container } = render(
      <Sidebar section="all" onSelectSection={noop} storage={storage} dropTarget={null} onFreeUp={noop} compact />,
    );
    for (const name of ["All files", "Documents", "Audio", "Video", "Images", "Downloads", "Trash"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("progressbar", { name: "Storage: 8.5 GB of 10 GB" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("marks the current folder in the breadcrumb trail", async () => {
    const { container } = render(<Breadcrumbs currentPath="Docs/2024" onNavigate={noop} dropTarget={null} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByText("2024").getAttribute("aria-current")).toBe("location");
    expect(screen.getByRole("button", { name: "Docs" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("trash", () => {
  const trash: TrashItem[] = [
    { id: "t1", original: "Docs", name: "old.txt", isFolder: false, size: 3, deletedMs: 1_700_000_000_000 },
    { id: "t2", original: "", name: "Photos", isFolder: true, size: 0, deletedMs: 1_700_000_000_000 },
  ];

  it("is a table of rows and cells, and every action names the file it acts on", async () => {
    const { container } = render(
      <TrashView items={trash} loading={false} onRestore={noop} onPurge={noop} onEmptyTrash={noop} />,
    );
    const table = screen.getByRole("table", { name: "Deleted files" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Restore old.txt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permanently delete Photos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Empty trash" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("announces an empty trash and a loading trash", () => {
    const { rerender } = render(
      <TrashView items={[]} loading={false} onRestore={noop} onPurge={noop} onEmptyTrash={noop} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Trash is empty");
    rerender(<TrashView items={[]} loading onRestore={noop} onPurge={noop} onEmptyTrash={noop} />);
    expect(screen.getByRole("status").textContent).toContain("Loading trash");
  });
});

describe("the whole Files window", () => {
  beforeEach(() => {
    vi.mocked(call).mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "fs_list":
          return items;
        case "fs_usage":
          return { used: 100, limit: 1000 };
        case "fs_trash_list":
          return [];
        case "fs_clip_get":
          return null;
        default:
          return undefined;
      }
    });
  });

  async function ready() {
    render(<FileExplorer />);
    await waitFor(() => expect(screen.queryAllByRole("row").length).toBeGreaterThan(1));
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    });
  }

  it("has no axe violations in the list view, and every toolbar button is named", async () => {
    await ready();
    for (const name of ["Back", "Forward", "Up one folder", "Refresh", "New folder"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // Plain action buttons are not announced as toggles.
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("aria-pressed")).toBe(false);
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeTruthy();
    expect(screen.getByLabelText("Search files")).toBeTruthy();
    await expectNoAxeViolations();
  });

  it("switches to the grid view with the arrow keys and still has no violations", async () => {
    const user = userEvent.setup();
    await ready();
    screen.getByRole("radio", { name: "List" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("listbox", { name: "Files" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Grid" }));
    await expectNoAxeViolations();
  });

  it("opens the context menu from the keyboard (the menu key) and returns to the list on Escape", async () => {
    const user = userEvent.setup();
    await ready();
    const grid = screen.getByRole("grid", { name: "Files" });
    grid.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "File context menu" });
    expect(menu.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(grid);
  });
});
