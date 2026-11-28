/**
 * Rulebox-release hooks. Like `../index.ts`, the implementation is picked at build time: `vite.config.ts` points
 * `@rulebox/release-impl` at `demo.ts` (VITE_DEMO=1) or `live.ts`. Imported only by the (lazy) Settings → Updates tab.
 */
import { releaseApi } from "@rulebox/release-impl";
import type { ReleaseApi } from "./api";

const api: ReleaseApi = releaseApi;

export const { useRelease, useSetRelease, useGithubReleases } = api;
