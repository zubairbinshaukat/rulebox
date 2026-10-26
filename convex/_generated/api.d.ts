/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as dev from "../dev.js";
import type * as devices from "../devices.js";
import type * as enrollment from "../enrollment.js";
import type * as health from "../health.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_deepEqual from "../lib/deepEqual.js";
import type * as lib_deviceAuth from "../lib/deviceAuth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_members from "../lib/members.js";
import type * as lib_validators from "../lib/validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  dev: typeof dev;
  devices: typeof devices;
  enrollment: typeof enrollment;
  health: typeof health;
  "lib/audit": typeof lib_audit;
  "lib/authz": typeof lib_authz;
  "lib/crypto": typeof lib_crypto;
  "lib/deepEqual": typeof lib_deepEqual;
  "lib/deviceAuth": typeof lib_deviceAuth;
  "lib/errors": typeof lib_errors;
  "lib/functions": typeof lib_functions;
  "lib/limits": typeof lib_limits;
  "lib/members": typeof lib_members;
  "lib/validators": typeof lib_validators;
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
