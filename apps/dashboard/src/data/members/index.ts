/**
 * Members list hooks. Like `../index.ts`, the implementation is picked at build
 * time: `vite.config.ts` points `@rulebox/members-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by the (lazy) Settings screen.
 */
import { membersApi } from "@rulebox/members-impl";
import type { MembersApi } from "./api";

const api: MembersApi = membersApi;

export const { useMembersPage, useInvitesPage } = api;
