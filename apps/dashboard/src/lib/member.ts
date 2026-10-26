import { createContext, useContext } from "react";
import type { Me, Role } from "../data/types";

const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export const MeContext = createContext<Me | null>(null);

/** The signed-in member (inside `RequireMember`). */
export function useMember(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMember() outside RequireMember");
  return me;
}

/** `true` when the signed-in member has at least `min`. */
export function useCan(min: Role): boolean {
  const me = useContext(MeContext);
  return me ? roleAtLeast(me.role, min) : false;
}