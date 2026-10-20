import { useReducer } from "react";

export interface SelectionState {
  selected: string[];
  focused: string | null;
  anchor: string | null;
}

export type SelectionAction =
  | { type: "SELECT_SINGLE"; path: string }
  | { type: "TOGGLE"; path: string }
  | { type: "SELECT_RANGE"; targetPath: string; allPaths: string[] }
  | { type: "SELECT_ALL"; allPaths: string[] }
  | { type: "CLEAR" }
  | { type: "MOVE_FOCUS"; path: string }
  | { type: "EXTEND_FOCUS"; path: string; allPaths: string[] }
  | { type: "SET_FOCUS_ONLY"; path: string }
  | { type: "RIGHT_CLICK"; path: string }
  | { type: "PRUNE"; allPaths: string[] };

export const INITIAL_SELECTION: SelectionState = {
  selected: [],
  focused: null,
  anchor: null,
};

/** Pure selection reducer. */
export function selectionReducer(
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  switch (action.type) {
    case "SELECT_SINGLE":
      return {
        selected: [action.path],
        focused: action.path,
        anchor: action.path,
      };

    case "TOGGLE": {
      const exists = state.selected.includes(action.path);
      const nextSelected = exists
        ? state.selected.filter((p) => p !== action.path)
        : [...state.selected, action.path];
      return {
        selected: nextSelected,
        focused: action.path,
        anchor: action.path,
      };
    }

    case "SELECT_RANGE": {
      const { targetPath, allPaths } = action;
      if (allPaths.length === 0) {
        return state;
      }
      const targetIndex = allPaths.indexOf(targetPath);
      if (targetIndex === -1) {
        return state;
      }
      const anchorPath = state.anchor ?? state.focused ?? targetPath;
      let anchorIndex = allPaths.indexOf(anchorPath);
      if (anchorIndex === -1) {
        anchorIndex = targetIndex;
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = allPaths.slice(start, end + 1);

      return {
        selected: range,
        focused: targetPath,
        anchor: anchorPath,
      };
    }

    case "SELECT_ALL":
      return {
        selected: [...action.allPaths],
        focused: state.focused ?? action.allPaths[0] ?? null,
        anchor: state.anchor ?? action.allPaths[0] ?? null,
      };

    case "CLEAR":
      return {
        selected: [],
        focused: null,
        anchor: null,
      };

    case "MOVE_FOCUS":
      return {
        selected: [action.path],
        focused: action.path,
        anchor: action.path,
      };

    case "EXTEND_FOCUS": {
      const { path, allPaths } = action;
      const targetIndex = allPaths.indexOf(path);
      if (targetIndex === -1) {
        return state;
      }
      const anchorPath = state.anchor ?? state.focused ?? path;
      let anchorIndex = allPaths.indexOf(anchorPath);
      if (anchorIndex === -1) {
        anchorIndex = targetIndex;
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = allPaths.slice(start, end + 1);

      return {
        selected: range,
        focused: path,
        anchor: anchorPath,
      };
    }

    case "SET_FOCUS_ONLY":
      return {
        ...state,
        focused: action.path,
      };

    case "RIGHT_CLICK": {
      if (state.selected.includes(action.path)) {
        return {
          ...state,
          focused: action.path,
        };
      }
      return {
        selected: [action.path],
        focused: action.path,
        anchor: action.path,
      };
    }

    case "PRUNE": {
      const validSet = new Set(action.allPaths);
      const nextSelected = state.selected.filter((p) => validSet.has(p));
      const nextFocused = state.focused && validSet.has(state.focused) ? state.focused : null;
      const nextAnchor = state.anchor && validSet.has(state.anchor) ? state.anchor : null;
      return {
        selected: nextSelected,
        focused: nextFocused,
        anchor: nextAnchor,
      };
    }

    default:
      return state;
  }
}

/** Hook wrapping the selection reducer. */
export function useSelection(initial = INITIAL_SELECTION) {
  return useReducer(selectionReducer, initial);
}
