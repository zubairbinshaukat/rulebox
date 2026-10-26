import type { ReactNode } from "react";
import type { Role } from "../data/types";
import { useCan } from "../lib/member";

/**
 * Shows `children` only to members with at least `minRole`; others see
 * `fallback` (default nothing). Controls are removed, never shown disabled
 * and clickable, so a Viewer never meets a button that only errors.
 */
export function RoleGate({ minRole, children, fallback = null }: { minRole: Role; children: ReactNode; fallback?: ReactNode }) {
  return <>{useCan(minRole) ? children : fallback}</>;
}