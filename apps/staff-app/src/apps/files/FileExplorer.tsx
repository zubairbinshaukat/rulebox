import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Button, IconButton, SegmentedControl } from "@rulebox/ui";
import type { Clip, Entry, TrashItem, Usage } from "@rulebox/types";
import IconAltArrowLeft from "~icons/solar/alt-arrow-left-bold-duotone";
import IconAltArrowRight from "~icons/solar/alt-arrow-right-bold-duotone";
import IconAltArrowUp from "~icons/solar/alt-arrow-up-bold-duotone";
import IconAddFolder from "~icons/solar/add-folder-bold-duotone";
import IconMagnifier from "~icons/solar/magnifer-bold-duotone";
import IconRefresh from "~icons/solar/refresh-bold-duotone";
import IconSortDown from "~icons/solar/sort-from-top-to-bottom-bold-duotone";
import IconSortUp from "~icons/solar/sort-from-bottom-to-top-bold-duotone";
import IconListView from "~icons/solar/list-bold-duotone";
import IconGridView from "~icons/solar/widget-bold-duotone";

import { useTauriEvent } from "../../lib/events";
import { openFile } from "../../lib/files";
import { call, isTauri } from "../../lib/tauri";
import { Breadcrumbs } from "./Breadcrumbs";
import { ContextMenu } from "./ContextMenu";
import { Dialogs } from "./Dialogs";
import { DragGhost } from "./DragGhost";
import { fileErrorText } from "./errors";
import { FileGrid } from "./FileGrid";
import { FileList } from "./FileList";
import { resolveKeyAction, TypeAheadBuffer } from "./keymap";
import { GRID_ROW_HEIGHT, LIST_ROW_HEIGHT } from "./layout";
import {
  canGoBack,
  canGoForward,
  currentOf,
  goBack,
  goForward,
  joinPath,
  newHistory,
  nextIndex,
  parentOf,
  pushHistory,
  uniqueName,
  type NavKey,
} from "./navigation";
import { Sidebar } from "./Sidebar";
import { getStorageThreshold } from "./storage";
import { TrashView } from "./TrashView";
import { toolbarModeFor, type ToolbarMode } from "./layout";
import type { DialogState, SidebarSection, SortConfig, SortField, ViewMode } from "./types";
import { CATEGORY_TITLES, categoryKind, filterEntriesBySection, itemId, sortEntries } from "./utils";
import { useDragMove } from "./useDragMove";
import { useSelection } from "./useSelection";

export interface FileExplorerProps {
  initialPath?: string;
}

const SEARCH_DELAY_MS = 150;
const RELOAD_DELAY_MS = 100;

const SORT_LABELS: Record<SortField, string> = {
  name: "Name",
  type: "Type",
  size: "Size",
  modified: "Date modified",
};

/** Below this window width the sidebar shows icons only. */
const COMPACT_SIDEBAR_BELOW = 720;


function locationSection(path: string): SidebarSection {
  return path === "Downloads" ? "downloads" : "all";
}

export function FileExplorer({ initialPath = "" }: FileExplorerProps) {
  // Where we are
  const [history, setHistory] = useState(() => newHistory(initialPath));
  const [section, setSection] = useState<SidebarSection>(() => locationSection(initialPath));
  const currentDir = currentOf(history);

  // What is shown
  const [entries, setEntries] = useState<Entry[]>([]);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortConfig>({ field: "name", direction: "asc" });

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Entry[] | null>(null);
  const searchIdRef = useRef(0);
  const searchTimer = useRef<number | undefined>(undefined);

  // Selection, rename, clipboard, menus, dialogs
  const [selection, dispatchSelection] = useSelection();
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetPath: string | null;
    openWithApp: string | null;
  } | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });
  const [usage, setUsage] = useState<Usage>({ used: 0, limit: 0 });
  const [announcement, setAnnouncement] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode>("wide");
  const category = categoryKind(section);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const typeAhead = useRef(new TypeAheadBuffer(500));
  const columnsRef = useRef(4);
  const reloadTimer = useRef<number | undefined>(undefined);
  const quietReload = useRef(false);
  const [reloadTick, setReloadTick] = useState(0);

  // The toolbar's layout follows the width of the area beside the sidebar.
  useEffect(() => {
    const el = mainRef.current;
    // Test DOMs have no ResizeObserver: the default layout stays.
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setToolbarMode(toolbarModeFor(box.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A narrow window turns the sidebar into a rail of icons.
  const [compactSidebar, setCompactSidebar] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    // Test DOMs have no ResizeObserver: the default layout stays.
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setCompactSidebar(box.width < COMPACT_SIDEBAR_BELOW);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onColumns = useCallback((columns: number) => {
    columnsRef.current = columns;
  }, []);

  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const showError = useCallback((title: string, message: string) => {
    setDialog({ type: "error", title, message });
  }, []);

  const focusList = useCallback(() => {
    window.requestAnimationFrame(() => {
      // Never take the focus away from a text field the person is typing in (rename, search).
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && containerRef.current?.contains(active)) {
        return;
      }
      const list = containerRef.current?.querySelector<HTMLElement>("[data-explorer-list]");
      // Before the list exists the window itself holds the focus, so keys still arrive.
      (list ?? containerRef.current)?.focus();
    });
  }, []);

  // ---- Loading ---------------------------------------------------------

  /**
   * Load the folder (or the trash) again. A quiet reload keeps what is on
   * screen; a normal one shows the skeleton rows first.
   */
  const refresh = useCallback((quiet: boolean) => {
    quietReload.current = quiet;
    if (!quiet) {
      setLoading(true);
      setFolderError(null);
    }
    setReloadTick((n) => n + 1);
  }, []);

  // Runs when the place, the section or the reload counter changes. A change of
  // place sets `loading` itself (see `showLocation`), so nothing is set before the first await.
  useEffect(() => {
    let current = true;
    async function run() {
      try {
        const kind = categoryKind(section);
        if (section === "trash") {
          const list = isTauri() ? await call("fs_trash_list", {}) : [];
          if (current) setTrashItems(list);
        } else if (kind) {
          // A category: every file of that kind in the whole folder, newest first.
          const list = isTauri() ? await call("fs_files", { kind, limit: 1000 }) : [];
          if (current) {
            setEntries(list);
            setFolderError(null);
          }
        } else {
          const list = isTauri() ? await call("fs_list", { path: currentDir }) : [];
          if (current) {
            setEntries(list);
            setFolderError(null);
          }
        }
      } catch {
        if (current) setFolderError("This folder can't be opened.");
      } finally {
        if (current) setLoading(false);
      }
    }
    void run();
    return () => {
      current = false;
    };
  }, [currentDir, section, reloadTick]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void call("fs_usage", {}).then(setUsage, () => undefined);
    void call("fs_clip_get", {}).then(setClip, () => undefined);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(reloadTimer.current);
      window.clearTimeout(searchTimer.current);
      // A search still running on the backend is not needed any more.
      if (isTauri()) {
        void call("fs_search", { query: "", searchId: 0 }).catch(() => undefined);
      }
    },
    [],
  );

  // Live refresh. A burst of changes (a paste of many files) is one reload.
  useTauriEvent<{ dir: string }>("files://changed", ({ dir }) => {
    // The trash and the categories span the whole folder: any change counts.
    if (section !== "trash" && !categoryKind(section) && dir !== currentDir) {
      return;
    }
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => refresh(true), RELOAD_DELAY_MS);
  });
  useTauriEvent<Usage>("files://usage", setUsage);
  useTauriEvent<Clip | null>("files://clipboard", setClip);
  useTauriEvent<{ searchId: number; hits: Entry[]; done: boolean }>("files://search", (batch) => {
    if (batch.searchId !== searchIdRef.current) {
      return;
    }
    setSearchResults((previous) => {
      const seen = new Set((previous ?? []).map((entry) => entry.path));
      return [...(previous ?? []), ...batch.hits.filter((entry) => !seen.has(entry.path))];
    });
  });

  // A file dropped on the window from outside must never navigate the WebView.
  useEffect(() => {
    const stop = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  // The list is ready for the keyboard as soon as the window opens, and again once it has loaded.
  useEffect(() => {
    if (!loading) focusList();
  }, [loading, focusList]);

  // ---- What is displayed -----------------------------------------------

  const displayedEntries = useMemo(() => {
    const raw = searchResults ?? entries;
    return sortEntries(filterEntriesBySection(raw, section), sort);
  }, [entries, searchResults, section, sort]);

  const allPaths = useMemo(() => displayedEntries.map((entry) => entry.path), [displayedEntries]);
  const selectedSet = useMemo(() => new Set(selection.selected), [selection.selected]);
  const cutSet = useMemo(
    () => (clip?.op === "cut" ? new Set(clip.paths) : new Set<string>()),
    [clip],
  );

  // What was selected may be gone after a reload.
  useEffect(() => {
    dispatchSelection({ type: "PRUNE", allPaths });
  }, [allPaths, dispatchSelection]);

  const storage = getStorageThreshold(usage.used, usage.limit);

  // ---- Navigation ------------------------------------------------------

  function resetView() {
    dispatchSelection({ type: "CLEAR" });
    setRenamingPath(null);
    window.clearTimeout(searchTimer.current);
    searchIdRef.current += 1;
    setSearchQuery("");
    setSearchResults(null);
  }

  function showLocation(next: typeof history) {
    resetView();
    setLoading(true);
    setFolderError(null);
    setHistory(next);
    setSection(locationSection(currentOf(next)));
    focusList();
  }

  function navigateTo(path: string) {
    showLocation(pushHistory(history, path));
  }

  function back() {
    if (canGoBack(history)) showLocation(goBack(history));
  }

  function forward() {
    if (canGoForward(history)) showLocation(goForward(history));
  }

  function up() {
    if (section !== "trash" && currentDir) navigateTo(parentOf(currentDir));
  }

  function selectSection(next: SidebarSection) {
    resetView();
    setLoading(true);
    setFolderError(null);
    setSection(next);
    if (next === "trash") {
      focusList();
      return;
    }
    setHistory(pushHistory(history, next === "downloads" ? "Downloads" : ""));
    focusList();
  }

  function reload() {
    refresh(false);
  }

  // ---- Search ----------------------------------------------------------

  function startSearch(query: string) {
    setSearchQuery(query);
    window.clearTimeout(searchTimer.current);
    const text = query.trim();
    const id = ++searchIdRef.current;
    if (!text) {
      setSearchResults(null);
      if (isTauri()) void call("fs_search", { query: "", searchId: id }).catch(() => undefined);
      return;
    }
    setSearchResults([]);
    searchTimer.current = window.setTimeout(() => {
      if (isTauri()) {
        void call("fs_search", { query: text, searchId: id }).catch(() => undefined);
      }
    }, SEARCH_DELAY_MS);
  }

  function onSearchKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      startSearch("");
      focusList();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      if (!selection.focused && allPaths[0]) {
        dispatchSelection({ type: "MOVE_FOCUS", path: allPaths[0] });
      }
      focusList();
    }
  }

  // ---- Actions ---------------------------------------------------------

  async function openEntry(entry: Entry) {
    if (entry.kind === "folder") {
      navigateTo(entry.path);
      return;
    }
    try {
      const action = await openFile(entry.path);
      if (action.action === "launched") {
        announce(`Opened with ${action.appName}`);
      } else if (action.action === "blocked") {
        setDialog({ type: "blocked", filename: entry.name });
      } else if (action.action === "noHandler") {
        setDialog({ type: "noHandler", filename: entry.name, extension: action.extension });
      }
    } catch (error) {
      showError("Can't open file", fileErrorText(error, entry.name));
    }
  }

  async function openWith(path: string, name: string) {
    try {
      const action = await call("fs_open_with", { path });
      if (action.action === "launched") {
        announce(`Opened with ${action.appName}`);
      } else if (action.action === "blocked") {
        setDialog({ type: "blocked", filename: name });
      } else if (action.action === "noHandler") {
        setDialog({ type: "noHandler", filename: name, extension: action.extension });
      }
    } catch (error) {
      showError("Can't open file", fileErrorText(error, name));
    }
  }

  async function commitRename(oldPath: string, newName: string) {
    setRenamingPath(null);
    const newPath = joinPath(parentOf(oldPath), newName);
    try {
      await call("fs_rename", { from: oldPath, to: newPath });
      announce(`Renamed to ${newName}`);
      // The focus follows the item, which is in the list again once the change arrives.
      dispatchSelection({ type: "SELECT_SINGLE", path: newPath });
      focusList();
    } catch (error) {
      showError("Couldn't rename", fileErrorText(error, newName));
    }
  }

  async function trashPaths(paths: string[]) {
    const failed: string[] = [];
    for (const path of paths) {
      try {
        await call("fs_trash", { path, permanent: false });
      } catch (error) {
        failed.push(`${path.split("/").pop() ?? path}: ${fileErrorText(error)}`);
      }
    }
    if (failed.length > 0) {
      showError("Couldn't move to trash", failed.slice(0, 3).join("\n"));
    } else {
      announce(paths.length === 1 ? "Moved to trash" : `${paths.length} items moved to trash`);
    }
  }

  function requestDelete(paths: string[], permanent: boolean) {
    if (paths.length === 0) {
      return;
    }
    if (!permanent) {
      void trashPaths(paths);
      return;
    }
    setDialog({
      type: "confirmDelete",
      permanent: true,
      items: paths.map((path) => ({
        path,
        name: entries.find((entry) => entry.path === path)?.name ?? path,
      })),
    });
  }

  async function confirmDelete(items: { name: string; path: string }[], permanent: boolean) {
    const failed: string[] = [];
    for (const item of items) {
      try {
        await call("fs_trash", { path: item.path, permanent });
      } catch (error) {
        failed.push(`${item.name}: ${fileErrorText(error, item.name)}`);
      }
    }
    if (failed.length > 0) {
      showError("Couldn't delete", failed.slice(0, 3).join("\n"));
    } else {
      announce(permanent ? "Deleted permanently" : "Moved to trash");
    }
  }

  async function setClipboard(op: "copy" | "cut") {
    if (selection.selected.length === 0) {
      return;
    }
    try {
      await call("fs_clip_set", { op, paths: selection.selected });
      announce(`${selection.selected.length} ${selection.selected.length === 1 ? "item" : "items"} ${op === "copy" ? "copied" : "cut"}`);
    } catch (error) {
      showError("Couldn't use the clipboard", fileErrorText(error));
    }
  }

  async function paste(toDir = currentDir) {
    if (!clip || clip.paths.length === 0) {
      return;
    }
    try {
      const result = await call("fs_paste", { toDir });
      if (result.failed.length > 0) {
        const first = result.failed[0];
        showError(
          `${result.failed.length} ${result.failed.length === 1 ? "item" : "items"} couldn't be pasted`,
          first ? fileErrorText(first.error, first.path.split("/").pop()) : "",
        );
      } else {
        announce(result.pasted.length === 1 ? "Pasted 1 item" : `Pasted ${result.pasted.length} items`);
      }
      const first = result.pasted[0];
      if (first !== undefined) {
        dispatchSelection({ type: "SELECT_SINGLE", path: first });
      }
    } catch (error) {
      showError("Couldn't paste", fileErrorText(error));
    }
  }

  async function createFolder(name: string) {
    try {
      const path = joinPath(currentDir, name);
      await call("fs_mkdir", { path });
      announce(`Created folder ${name}`);
      dispatchSelection({ type: "SELECT_SINGLE", path });
      focusList();
    } catch (error) {
      showError("Couldn't create the folder", fileErrorText(error, name));
    }
  }

  function askNewFolder() {
    setDialog({ type: "newFolder", defaultName: uniqueName("New folder", entries.map((e) => e.name)) });
  }

  async function moveInto(dir: string, paths: string[]) {
    const failed: string[] = [];
    for (const from of paths) {
      try {
        await call("fs_move", { from, toDir: dir });
      } catch (error) {
        failed.push(`${from.split("/").pop() ?? from}: ${fileErrorText(error)}`);
      }
    }
    if (failed.length > 0) {
      showError("Couldn't move", failed.slice(0, 3).join("\n"));
    } else {
      announce(`Moved ${paths.length === 1 ? "1 item" : `${paths.length} items`}`);
    }
  }

  async function restoreItem(id: string, name: string) {
    try {
      await call("fs_restore", { id });
      announce(`Restored ${name}`);
      refresh(true);
    } catch (error) {
      showError("Couldn't restore", fileErrorText(error, name));
    }
  }

  async function purgeItem(id: string | null, name: string) {
    try {
      await call("fs_purge", { id });
      announce(id === null ? "Trash emptied" : `Deleted ${name}`);
      refresh(true);
    } catch (error) {
      showError("Couldn't delete", fileErrorText(error, name));
    }
  }

  // ---- Drag to move ----------------------------------------------------

  const { drag, startDrag, consumeClick } = useDragMove((dir, paths) => void moveInto(dir, paths));

  function onItemPointerDown(entry: Entry, event: PointerEvent) {
    if (renamingPath || event.ctrlKey || event.shiftKey || event.metaKey) {
      return;
    }
    const paths = selectedSet.has(entry.path) ? selection.selected : [entry.path];
    startDrag(event, paths, entry.name);
  }

  // ---- Mouse -----------------------------------------------------------

  function onItemClick(path: string, event: MouseEvent) {
    if (consumeClick()) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      dispatchSelection({ type: "TOGGLE", path });
    } else if (event.shiftKey) {
      dispatchSelection({ type: "SELECT_RANGE", targetPath: path, allPaths });
    } else {
      dispatchSelection({ type: "SELECT_SINGLE", path });
    }
  }

  function openMenu(x: number, y: number, targetPath: string | null) {
    setContextMenu({ x, y, targetPath, openWithApp: null });
    const entry = targetPath ? displayedEntries.find((e) => e.path === targetPath) : undefined;
    if (entry && entry.kind === "file" && isTauri()) {
      void call("fs_handler", { path: entry.path }).then(
        (app) =>
          setContextMenu((menu) => (menu && menu.targetPath === entry.path ? { ...menu, openWithApp: app } : menu)),
        () => undefined,
      );
    }
  }

  function onItemContextMenu(path: string, event: MouseEvent) {
    event.preventDefault();
    dispatchSelection({ type: "RIGHT_CLICK", path });
    openMenu(event.clientX, event.clientY, path);
  }

  // The native menu never shows; on empty space ours does.
  function onContainerContextMenu(event: MouseEvent) {
    event.preventDefault();
    if (section === "trash" || (event.target as HTMLElement).closest('[role="row"], [role="option"]')) {
      return;
    }
    if ((event.target as HTMLElement).closest("[data-explorer-list]")) {
      openMenu(event.clientX, event.clientY, null);
    }
  }

  // ---- Keyboard --------------------------------------------------------

  function moveFocus(key: NavKey, extend: boolean) {
    const index = selection.focused ? allPaths.indexOf(selection.focused) : -1;
    const rowHeight = viewMode === "grid" ? GRID_ROW_HEIGHT : LIST_ROW_HEIGHT;
    const rows = Math.max(1, Math.floor((containerRef.current?.clientHeight ?? 400) / rowHeight) - 2);
    const columns = viewMode === "grid" ? columnsRef.current : 1;
    const next = nextIndex(key, { count: allPaths.length, index, view: viewMode, columns, pageSize: rows * columns });
    const path = allPaths[next];
    if (path === undefined) {
      return;
    }
    dispatchSelection(extend ? { type: "EXTEND_FOCUS", path, allPaths } : { type: "MOVE_FOCUS", path });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target === searchInputRef.current) {
      onSearchKeyDown(event);
      return;
    }
    // Text fields (rename, dialogs) handle their own keys.
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
      return;
    }
    const action = resolveKeyAction(event, {
      isDialog: dialog.type !== "none",
      isMenu: contextMenu !== null,
    });
    if (!action) {
      return;
    }
    if (section === "trash") {
      if (action.type === "refresh" || action.type === "history-back" || action.type === "history-forward") {
        event.preventDefault();
        if (action.type === "refresh") reload();
        else if (action.type === "history-back") back();
        else forward();
      }
      return;
    }
    const focusedEntry = displayedEntries.find((entry) => entry.path === selection.focused);
    const targets = selection.selected.length > 0 ? selection.selected : selection.focused ? [selection.focused] : [];

    switch (action.type) {
      case "nav-arrow":
        event.preventDefault();
        moveFocus(action.direction, action.extend);
        break;
      case "nav-home":
        event.preventDefault();
        moveFocus("home", action.extend);
        break;
      case "nav-end":
        event.preventDefault();
        moveFocus("end", action.extend);
        break;
      case "nav-page-up":
        event.preventDefault();
        moveFocus("pageUp", action.extend);
        break;
      case "nav-page-down":
        event.preventDefault();
        moveFocus("pageDown", action.extend);
        break;
      case "select-all":
        event.preventDefault();
        // "N items selected" is announced by the selection's own live region.
        dispatchSelection({ type: "SELECT_ALL", allPaths });
        break;
      case "open":
        event.preventDefault();
        if (focusedEntry) void openEntry(focusedEntry);
        break;
      case "rename":
        event.preventDefault();
        if (selection.focused) setRenamingPath(selection.focused);
        break;
      case "delete":
        event.preventDefault();
        requestDelete(targets, action.permanent);
        break;
      case "copy":
        event.preventDefault();
        void setClipboard("copy");
        break;
      case "cut":
        event.preventDefault();
        void setClipboard("cut");
        break;
      case "paste":
        event.preventDefault();
        void paste();
        break;
      case "parent":
        event.preventDefault();
        up();
        break;
      case "history-back":
        event.preventDefault();
        back();
        break;
      case "history-forward":
        event.preventDefault();
        forward();
        break;
      case "refresh":
        event.preventDefault();
        reload();
        break;
      case "search":
        event.preventDefault();
        searchInputRef.current?.focus();
        break;
      case "new-folder":
        event.preventDefault();
        askNewFolder();
        break;
      case "context-menu": {
        event.preventDefault();
        const row = selection.focused ? document.getElementById(itemId(selection.focused)) : null;
        const box = (row ?? containerRef.current)?.getBoundingClientRect();
        openMenu((box?.left ?? 100) + 40, (box?.top ?? 100) + (row ? 24 : 80), selection.focused);
        break;
      }
      case "cancel":
        if (dialog.type !== "none") setDialog({ type: "none" });
        else if (contextMenu) setContextMenu(null);
        else if (searchQuery) startSearch("");
        else dispatchSelection({ type: "CLEAR" });
        break;
      case "type-ahead": {
        const match = typeAhead.current.push(action.char, displayedEntries);
        if (match) dispatchSelection({ type: "MOVE_FOCUS", path: match });
        break;
      }
    }
  }

  // ---- Rendering -------------------------------------------------------

  const menuEntry = contextMenu?.targetPath
    ? displayedEntries.find((entry) => entry.path === contextMenu.targetPath)
    : undefined;
  const dropTarget = drag?.target ?? null;
  const selectedCount = selection.selected.length;

  return (
    <div
      ref={containerRef}
      onKeyDown={onKeyDown}
      onContextMenu={onContainerContextMenu}
      style={explorerRoot}
      tabIndex={-1}
    >
      <div aria-live="polite" aria-atomic="true" style={srOnly}>
        {announcement}
      </div>
      <div aria-live="polite" aria-atomic="true" style={srOnly}>
        {selectedCount > 1 ? `${selectedCount} items selected` : ""}
      </div>

      <Sidebar
        section={section}
        storage={storage}
        dropTarget={dropTarget}
        onSelectSection={selectSection}
        onFreeUp={() => selectSection("trash")}
        compact={compactSidebar}
      />

      <div ref={mainRef} style={mainArea}>
        <div style={toolbar}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <IconButton label="Back" size={32} disabled={!canGoBack(history)} onClick={back}>
              <IconAltArrowLeft width={18} height={18} />
            </IconButton>
            <IconButton label="Forward" size={32} disabled={!canGoForward(history)} onClick={forward}>
              <IconAltArrowRight width={18} height={18} />
            </IconButton>
            <IconButton
              label="Up one folder"
              size={32}
              disabled={!currentDir || section === "trash" || category !== null}
              onClick={up}
            >
              <IconAltArrowUp width={18} height={18} />
            </IconButton>
          </div>

          <div style={{ flex: "1 1 0", minWidth: 0, margin: "0 12px" }}>
            {section === "trash" ? (
              <span style={placeTitle}>Trash</span>
            ) : category ? (
              <span style={placeTitle}>
                {CATEGORY_TITLES[section as keyof typeof CATEGORY_TITLES]}
                <span style={placeHint}>in all your folders</span>
              </span>
            ) : (
              <Breadcrumbs currentPath={currentDir} onNavigate={navigateTo} dropTarget={dropTarget} />
            )}
          </div>

          {section !== "trash" ? (
            <div
              style={{
                ...toolbarControls,
                // Below the full width the controls get a row of their own, led by the search.
                flex: toolbarMode === "wide" ? "0 1 auto" : "1 1 100%",
                justifyContent: toolbarMode === "wide" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  position: "relative",
                  flex: toolbarMode === "wide" ? "0 1 220px" : "1 1 auto",
                  minWidth: 120,
                }}
              >
                <span aria-hidden style={searchIcon}>
                  <IconMagnifier width={14} height={14} />
                </span>
                <input
                  ref={searchInputRef}
                  className="rb-input"
                  placeholder="Search files"
                  aria-label="Search files"
                  value={searchQuery}
                  onChange={(event) => startSearch(event.target.value)}
                  style={{ width: "100%", height: 32, paddingLeft: 30, fontSize: 13 }}
                />
              </div>

              {toolbarMode !== "narrow" ? (
                <select
                  className="rb-input"
                  aria-label="Sort by"
                  value={sort.field}
                  onChange={(event) => setSort((prev) => ({ ...prev, field: event.target.value as SortField }))}
                  style={{ height: 32, fontSize: 13, width: 132, flexShrink: 0 }}
                >
                  {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
                    <option key={field} value={field}>
                      {SORT_LABELS[field]}
                    </option>
                  ))}
                </select>
              ) : null}
              <IconButton
                label={sort.direction === "asc" ? "Sorted ascending" : "Sorted descending"}
                size={32}
                onClick={() => setSort((prev) => ({ ...prev, direction: prev.direction === "asc" ? "desc" : "asc" }))}
              >
                {sort.direction === "asc" ? (
                  <IconSortDown width={18} height={18} />
                ) : (
                  <IconSortUp width={18} height={18} />
                )}
              </IconButton>

              {toolbarMode === "narrow" ? (
                <IconButton
                  label={viewMode === "list" ? "Show as grid" : "Show as list"}
                  size={32}
                  onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
                >
                  {viewMode === "list" ? <IconGridView width={18} height={18} /> : <IconListView width={18} height={18} />}
                </IconButton>
              ) : (
                <SegmentedControl<ViewMode>
                  aria-label="View"
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { value: "list", label: "List" },
                    { value: "grid", label: "Grid" },
                  ]}
                />
              )}

              {category === null ? (
                <IconButton label="New folder" size={32} onClick={askNewFolder}>
                  <IconAddFolder width={18} height={18} />
                </IconButton>
              ) : null}
              <IconButton label="Refresh" size={32} onClick={reload}>
                <IconRefresh width={18} height={18} />
              </IconButton>
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {section === "trash" ? (
            <TrashView
              items={trashItems}
              loading={loading}
              onRestore={(id, name) => void restoreItem(id, name)}
              onPurge={(id, name) => void purgeItem(id, name)}
              onEmptyTrash={() => void purgeItem(null, "")}
            />
          ) : folderError ? (
            <div style={centered}>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{folderError}</p>
              <Button type="button" onClick={() => selectSection("all")}>
                Go to All files
              </Button>
            </div>
          ) : loading ? (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-busy="true">
              {[0, 1, 2, 3, 4].map((n) => (
                <div key={n} style={skeletonRow} />
              ))}
            </div>
          ) : searchQuery.trim() && searchResults !== null && searchResults.length === 0 ? (
            <div style={centered}>
              <p style={muted}>Nothing matches “{searchQuery.trim()}”</p>
            </div>
          ) : displayedEntries.length === 0 ? (
            <div style={centered}>
              <p style={muted}>This folder is empty.</p>
            </div>
          ) : viewMode === "list" ? (
            <FileList
              items={displayedEntries}
              selected={selectedSet}
              cut={cutSet}
              focusedPath={selection.focused}
              sort={sort}
              renamingPath={renamingPath}
              dropTarget={dropTarget}
              showLocation={category !== null || searchResults !== null}
              onSortChange={(field) =>
                setSort((prev) => ({
                  field,
                  direction: prev.field === field && prev.direction === "asc" ? "desc" : "asc",
                }))
              }
              onItemClick={onItemClick}
              onItemDoubleClick={(entry) => void openEntry(entry)}
              onItemContextMenu={onItemContextMenu}
              onItemPointerDown={onItemPointerDown}
              onCommitRename={(path, name) => void commitRename(path, name)}
              onCancelRename={() => {
                setRenamingPath(null);
                focusList();
              }}
            />
          ) : (
            <FileGrid
              items={displayedEntries}
              selected={selectedSet}
              cut={cutSet}
              focusedPath={selection.focused}
              renamingPath={renamingPath}
              dropTarget={dropTarget}
              onColumns={onColumns}
              onItemClick={onItemClick}
              onItemDoubleClick={(entry) => void openEntry(entry)}
              onItemContextMenu={onItemContextMenu}
              onItemPointerDown={onItemPointerDown}
              onCommitRename={(path, name) => void commitRename(path, name)}
              onCancelRename={() => {
                setRenamingPath(null);
                focusList();
              }}
            />
          )}
        </div>
      </div>

      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasTarget={contextMenu.targetPath !== null}
          canPaste={clip !== null && clip.paths.length > 0}
          openWithApp={contextMenu.openWithApp}
          onOpen={() => menuEntry && void openEntry(menuEntry)}
          onOpenWith={() => menuEntry && void openWith(menuEntry.path, menuEntry.name)}
          onRename={() => contextMenu.targetPath && setRenamingPath(contextMenu.targetPath)}
          onCopy={() => void setClipboard("copy")}
          onCut={() => void setClipboard("cut")}
          onPaste={() => void paste(menuEntry?.kind === "folder" ? menuEntry.path : currentDir)}
          onTrash={() => requestDelete(selection.selected.length > 0 ? selection.selected : [contextMenu.targetPath ?? ""].filter(Boolean), false)}
          onNewFolder={askNewFolder}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      <Dialogs
        dialog={dialog}
        onClose={() => {
          setDialog({ type: "none" });
          focusList();
        }}
        onConfirmDelete={(items, permanent) => void confirmDelete(items, permanent)}
        onCreateFolder={(name) => void createFolder(name)}
      />

      <DragGhost drag={drag} />
    </div>
  );
}

const explorerRoot: CSSProperties = {
  display: "flex",
  width: "100%",
  height: "100%",
  background: "var(--rb-bg)",
  color: "var(--rb-ink)",
  overflow: "hidden",
  outline: "none",
  position: "relative",
};

const mainArea: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 16px",
  borderBottom: "1px solid var(--rb-line)",
  background: "var(--rb-surface)",
  minHeight: 48,
  flexShrink: 0,
  gap: 4,
  // A narrow window puts the controls on a second row instead of cutting them off.
  flexWrap: "wrap",
  rowGap: 8,
};

const placeTitle: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: 8,
  fontWeight: 600,
  fontSize: 14,
  whiteSpace: "nowrap",
};

const placeHint: CSSProperties = {
  fontWeight: 400,
  fontSize: 12.5,
  color: "var(--rb-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const toolbarControls: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
  flex: "1 1 auto",
  minWidth: 0,
};

const centered: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 32,
};

const muted: CSSProperties = { margin: 0, color: "var(--rb-muted)", fontSize: 14 };

const skeletonRow: CSSProperties = {
  height: 36,
  borderRadius: 8,
  background: "var(--rb-line)",
  opacity: 0.5,
};

const searchIcon: CSSProperties = {
  position: "absolute",
  left: 10,
  top: "50%",
  transform: "translateY(-50%)",
  display: "flex",
  color: "var(--rb-muted)",
  pointerEvents: "none",
};

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
