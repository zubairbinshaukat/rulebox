/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as dev from "../dev.js";
import type * as devices from "../devices.js";
import type * as enrollment from "../enrollment.js";
import type * as health from "../health.js";
import type * as lib_deepEqual from "../lib/deepEqual.js";
import type * as lib_deviceAuth from "../lib/deviceAuth.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  dev: typeof dev;
  devices: typeof devices;
  enrollment: typeof enrollment;
  health: typeof health;
  "lib/deepEqual": typeof lib_deepEqual;
  "lib/deviceAuth": typeof lib_deviceAuth;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
