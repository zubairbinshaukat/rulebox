

export type ViewMode = "grid" | "list";

export type SortField = "name" | "type" | "size" | "modified";
export type SortDirection = "asc" | "desc";

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

export type SidebarSection =
  | "all"
  | "documents"
  | "audio"
  | "video"
  | "images"
  | "downloads"
  | "trash";

export type DialogState =
  | { type: "none" }
  | {
      type: "confirmDelete";
      items: { name: string; path: string; isFolder?: boolean }[];
      permanent: boolean;
    }
  | { type: "blocked"; filename: string }
  | { type: "noHandler"; filename: string; extension: string }
  | { type: "newFolder"; defaultName: string }
  | { type: "error"; title: string; message: string };

