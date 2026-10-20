import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, Entry, FileError, TrashItem } from "@rulebox/types";

import { call } from "../../lib/tauri";
import { FileExplorer } from "./FileExplorer";

// ---- A tiny in-memory backend that behaves like the Rust one --------------

vi.mock("../../lib/tauri", () => ({ call: vi.fn(), isTauri: () => true }));
vi.mock("../../lib/files", () => ({ openFile: vi.fn(async () => ({ action: "blocked" })) }));

const handlers = new Map<string, (payload: unknown) => void>();
vi.mock("../../lib/events", () => ({
  useTauriEvent: (name: string, handler: (payload: unknown) => void) => {
    handlers.set(name, handler);
  },
}));

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

class FakeDisk {
  files = new Map<string, number>(); // file path -> size
  folders = new Set<string>([""]);
  trash: (TrashItem & { isFolder: boolean })[] = [];
  clip: Clip | null = null;
  usage = { used: 0, limit: 10_000 };

  constructor() {
    this.folders.add("Docs");
    this.files.set("Docs/old.txt", 3);
    this.files.set("a.txt", 5);
    this.files.set("b.csv", 7);
  }

  private parent(path: string) {
    const slash = path.lastIndexOf("/");
    return slash > 0 ? path.slice(0, slash) : "";
  }

  private name(path: string) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  list(dir: string): Entry[] {
    const out: Entry[] = [];
    for (const folder of this.folders) {
      if (folder && this.parent(folder) === dir) {
        out.push({ name: this.name(folder), path: folder, kind: "folder", size: 0, modifiedMs: 1 });
      }
    }
    for (const [path, size] of this.files) {
      if (this.parent(path) === dir) {
        out.push({ name: this.name(path), path, kind: "file", size, modifiedMs: 1 });
      }
    }
    return out;
  }

  free(dir: string, name: string): string {
    const exists = (p: string) => this.files.has(p) || this.folders.has(p);
    const join = (n: string) => (dir ? `${dir}/${n}` : n);
    if (!exists(join(name))) return join(name);
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) {
      if (!exists(join(`${stem} (${n})${ext}`))) return join(`${stem} (${n})${ext}`);
    }
  }
}

let disk: FakeDisk;
const calls: { cmd: string; args: unknown }[] = [];

function reject(error: FileError): never {
  throw error;
}

function changed(dir: string) {
  act(() => handlers.get("files://changed")?.({ dir }));
}

function install() {
  vi.mocked(call).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "fs_list":
        return disk.list(a.path as string);
      case "fs_usage":
        return disk.usage;
      case "fs_clip_get":
        return disk.clip;
      case "fs_clip_set":
        disk.clip = { op: a.op as "copy" | "cut", paths: a.paths as string[] };
        act(() => handlers.get("files://clipboard")?.(disk.clip));
        return undefined;
      case "fs_handler":
        return null;
      case "fs_mkdir": {
        const path = a.path as string;
        if (disk.folders.has(path) || disk.files.has(path)) reject({ kind: "exists" });
        disk.folders.add(path);
        changed(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
        return undefined;
      }
      case "fs_rename": {
        const from = a.from as string;
        const to = a.to as string;
        if (disk.files.has(to) || disk.folders.has(to)) reject({ kind: "exists" });
        if (disk.folders.has(from)) {
          disk.folders.delete(from);
          disk.folders.add(to);
        } else {
          disk.files.set(to, disk.files.get(from) ?? 0);
          disk.files.delete(from);
        }
        changed("");
        return undefined;
      }
      case "fs_paste": {
        const clip = disk.clip;
        if (!clip) reject({ kind: "notFound" });
        const pasted: string[] = [];
        for (const from of clip.paths) {
          const target = disk.free(a.toDir as string, from.slice(from.lastIndexOf("/") + 1));
          disk.files.set(target, disk.files.get(from) ?? 0);
          if (clip.op === "cut") disk.files.delete(from);
          pasted.push(target);
        }
        if (clip.op === "cut") disk.clip = null;
        changed(a.toDir as string);
        return { pasted, failed: [] };
      }
      case "fs_trash": {
        const path = a.path as string;
        const size = disk.files.get(path) ?? 0;
        disk.files.delete(path);
        if (!a.permanent) {
          disk.trash.push({
            id: `t${disk.trash.length + 1}`,
            original: path,
            name: path.slice(path.lastIndexOf("/") + 1),
            isFolder: false,
            size,
            deletedMs: 1,
          });
        }
        changed(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
        return undefined;
      }
      case "fs_trash_list":
        return disk.trash;
      case "fs_restore": {
        const item = disk.trash.find((t) => t.id === a.id);
        if (!item) reject({ kind: "notFound" });
        disk.files.set(disk.free("", item.name), item.size);
        disk.trash = disk.trash.filter((t) => t.id !== a.id);
        changed("");
        return item.original;
      }
      default:
        return undefined;
    }
  });
}

function names(): string[] {
  // The name is the element with a title; the file-type chip is text too.
  return screen
    .queryAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("span[title]")?.textContent ?? "");
}

function list(): HTMLElement {
  return screen.getByRole("grid", { name: "Files" });
}

function key(k: string, mods: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(list(), { key: k, ...mods });
}

async function ready() {
  render(<FileExplorer />);
  await waitFor(() => expect(names().length).toBeGreaterThan(0));
  // Let the explorer's own "focus the list" step run before the keyboard starts.
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
  });
}

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  disk = new FakeDisk();
  install();
});

describe("the file explorer, driven by the keyboard", () => {
  it("lists folders first, then files", async () => {
    await ready();
    expect(names()).toEqual(["Docs", "a.txt", "b.csv"]);
  });

  it("creates a folder, renames it, copies a file into it and pastes", async () => {
    await ready();

    // Ctrl+Shift+N asks for a name; the default is already free.
    key("N", { ctrlKey: true, shiftKey: true });
    const nameField = await screen.findByLabelText("Folder name");
    expect((nameField as HTMLInputElement).value).toBe("New folder");
    fireEvent.change(nameField, { target: { value: "Reports" } });
    fireEvent.submit(nameField.closest("form") as HTMLFormElement);
    await waitFor(() => expect(names()).toContain("Reports"));

    // The new folder is selected and focused: F2 renames it straight away.
    key("F2");
    const rename = await screen.findByLabelText("New name");
    expect((rename as HTMLInputElement).value).toBe("Reports");
    fireEvent.change(rename, { target: { value: "Reports 2024" } });
    fireEvent.submit(rename.closest("form") as HTMLFormElement);
    await waitFor(() => expect(names()).toContain("Reports 2024"));
    expect(calls.find((c) => c.cmd === "fs_rename")?.args).toEqual({ from: "Reports", to: "Reports 2024" });

    // Select a.txt with the keyboard, Ctrl+C, then paste in the same folder: it is numbered.
    key("ArrowDown");
    key("c", { ctrlKey: true });
    await waitFor(() => expect(disk.clip).toEqual({ op: "copy", paths: ["a.txt"] }));
    key("v", { ctrlKey: true });
    await waitFor(() => expect(names()).toContain("a (1).txt"));
    expect(disk.files.has("a.txt")).toBe(true);
  });

  it("cuts and pastes into another folder with the keyboard only", async () => {
    await ready();
    key("ArrowDown"); // Docs
    key("ArrowDown"); // a.txt
    key("x", { ctrlKey: true });
    await waitFor(() => expect(disk.clip?.op).toBe("cut"));
    key("ArrowUp"); // Docs
    key("Enter"); // open the folder
    await waitFor(() => expect(names()).toEqual(["old.txt"]));
    key("v", { ctrlKey: true });
    await waitFor(() => expect(names()).toEqual(["a.txt", "old.txt"]));
    expect(disk.files.has("a.txt")).toBe(false);
    expect(disk.files.has("Docs/a.txt")).toBe(true);
    // Backspace goes up one folder.
    key("Backspace");
    await waitFor(() => expect(names()).toEqual(["Docs", "b.csv"]));
  });

  it("deletes to the trash with Delete and restores from the trash", async () => {
    await ready();
    key("ArrowDown"); // Docs
    key("ArrowDown"); // a.txt
    key("Delete");
    await waitFor(() => expect(names()).toEqual(["Docs", "b.csv"]));
    expect(disk.trash).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    const restore = await screen.findByRole("button", { name: /Restore/ });
    fireEvent.click(restore);
    await waitFor(() => expect(disk.trash).toHaveLength(0));
    expect(disk.files.has("a.txt")).toBe(true);
  });

  it("asks before Shift+Delete and only deletes for good after the confirmation", async () => {
    await ready();
    key("ArrowDown");
    key("ArrowDown"); // a.txt
    key("Delete", { shiftKey: true });
    expect(await screen.findByText("Permanently delete?")).toBeTruthy();
    expect(disk.files.has("a.txt")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(disk.files.has("a.txt")).toBe(false));
    expect(disk.trash).toHaveLength(0);
    expect(calls.find((c) => c.cmd === "fs_trash")?.args).toEqual({ path: "a.txt", permanent: true });
  });

  it("selects everything with Ctrl+A and announces it", async () => {
    await ready();
    key("a", { ctrlKey: true });
    await waitFor(() => expect(screen.getAllByRole("row", { selected: true })).toHaveLength(3));
    expect(screen.getByText("3 items selected", { selector: "[aria-live]" })).toBeTruthy();
  });

  it("types ahead to a name and extends the selection with Shift+Arrow", async () => {
    await ready();
    key("b");
    await waitFor(() => expect(screen.getAllByRole("row", { selected: true })).toHaveLength(1));
    expect(screen.getByRole("row", { selected: true }).textContent).toContain("b.csv");
    key("ArrowUp", { shiftKey: true });
    await waitFor(() => expect(screen.getAllByRole("row", { selected: true })).toHaveLength(2));
  });

  it("opens the context menu with the Menu key and closes it with Escape", async () => {
    await ready();
    key("ArrowDown");
    key("ContextMenu");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
    // No "Open with" entry: no handler is configured.
    expect(within(menu).queryByRole("menuitem", { name: /Open with/ })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("does not let the search box steal list keys, and Escape clears the search", async () => {
    await ready();
    const search = screen.getByLabelText("Search files");
    fireEvent.keyDown(search, { key: "Backspace" });
    fireEvent.keyDown(search, { key: "Delete" });
    expect(calls.some((c) => c.cmd === "fs_trash")).toBe(false);
    expect(names()).toEqual(["Docs", "a.txt", "b.csv"]);
    fireEvent.change(search, { target: { value: "txt" } });
    expect((search as HTMLInputElement).value).toBe("txt");
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("does not open the file when Enter confirms a rename", async () => {
    await ready();
    key("ArrowDown");
    key("ArrowDown");
    key("F2");
    const rename = await screen.findByLabelText("New name");
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(calls.some((c) => c.cmd === "fs_open")).toBe(false);
  });

  it("names the rule an invalid rename breaks, and keeps the field open", async () => {
    await ready();
    key("ArrowDown");
    key("ArrowDown");
    key("F2");
    const rename = await screen.findByLabelText("New name");
    fireEvent.change(rename, { target: { value: "CON" } });
    expect((await screen.findByRole("alert")).textContent).toBe("That name is reserved by Windows.");
    fireEvent.submit(rename.closest("form") as HTMLFormElement);
    expect(calls.some((c) => c.cmd === "fs_rename")).toBe(false);
    fireEvent.keyDown(rename, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("New name")).toBeNull());
  });

  it("shows the reason when the backend refuses", async () => {
    await ready();
    key("ArrowDown");
    key("ArrowDown"); // a.txt
    key("F2");
    const rename = await screen.findByLabelText("New name");
    fireEvent.change(rename, { target: { value: "b.csv" } });
    fireEvent.submit(rename.closest("form") as HTMLFormElement);
    expect(await screen.findByText("Something with that name already exists.")).toBeTruthy();
  });
});
