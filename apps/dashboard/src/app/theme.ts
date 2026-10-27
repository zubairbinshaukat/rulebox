import { useCallback, useState } from "react";
import { setTheme, type Theme } from "@rulebox/ui";
import { readStorage, writeStorage } from "../lib/storage";

/**
 * Light / dark / match-system, remembered in this browser only.
 * `src/boot/boot.js` applies the saved choice before the first paint.
 */
const KEY = "rulebox.theme";

export function savedTheme(): Theme {
  const v = readStorage(KEY);
  return v === "light" || v === "dark" || v === "auto" ? v : "auto";
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(savedTheme);
  const update = useCallback((t: Theme) => {
    set(t);
    setTheme(t);
    writeStorage(KEY, t);
  }, []);
  return [theme, update];
}
