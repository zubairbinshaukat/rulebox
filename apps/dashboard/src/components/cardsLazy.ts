import { lazy, type ComponentType } from "react";
import type { CardGridProps, SkeletonCardsProps } from "./CardGrid";
import type { CardsSortSelectProps } from "./CardsSortSelect";

/**
 * The Cards view is loaded only when a list is shown as cards (`DataTable` renders these inside a
 * `Suspense`). The table path imports this file, never `CardGrid`, `CardsSortSelect` or `cardLayout`,
 * so the first signed-in page does not pay for them. (The Cards switch starts the same downloads early,
 * on hover and focus: `ViewSwitch.tsx`.)
 */
const loadGrid = () => import("./CardGrid");
const loadSort = () => import("./CardsSortSelect");

export const CardGridLazy = lazy(() => loadGrid().then((m) => ({ default: m.CardGrid as ComponentType<CardGridProps<unknown>> })));
export const SkeletonCardsLazy = lazy(() => loadGrid().then((m) => ({ default: m.SkeletonCards as ComponentType<SkeletonCardsProps> })));
export const CardsSortSelectLazy = lazy(() => loadSort().then((m) => ({ default: m.CardsSortSelect as ComponentType<CardsSortSelectProps> })));
