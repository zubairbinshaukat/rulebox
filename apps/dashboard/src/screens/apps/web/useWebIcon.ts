import { useCallback, useEffect, useRef, useState } from "react";
import { useSaveAppIcon } from "../../../data";
import { withHttps } from "./webAddress";

/** The icon "Fetch details" previewed (a `data:` URL) and the address it came from: stored with the app after it is saved, and only while the address still is that one. */
export interface FetchedIcon {
  forUrl: string;
  data: string;
}

export interface WebIconState {
  icon: FetchedIcon | null;
  setIcon: (next: FetchedIcon | null) => void;
  /** Stores the previewed icon for the saved app. Throws when the upload fails (the app is saved by then: the caller only warns). Does nothing when there is none for this address. */
  save: (appId: string, url: string) => Promise<void>;
}

/** The fetched icon of a website form, kept by the screen that saves (the form shows it; the screen stores it after `apps:createWeb` / `apps:update`). */
export function useWebIcon(): WebIconState {
  const saveIcon = useSaveAppIcon();
  const [icon, setIcon] = useState<FetchedIcon | null>(null);
  const latest = useRef(icon);
  useEffect(() => {
    latest.current = icon;
  });
  const save = useCallback(
    async (appId: string, url: string) => {
      const current = latest.current;
      if (current === null || current.forUrl !== withHttps(url)) return;
      await saveIcon({ appId, png: current.data });
      setIcon(null);
    },
    [saveIcon],
  );
  return { icon, setIcon, save };
}

/** The server's refusals the website form shows under their own field (pass to `FormError` as `fields` so they are not said twice). */
export const WEB_SERVER_FIELDS = ["allowedDomains", "url"] as const;
