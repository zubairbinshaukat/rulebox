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
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as dev from "../dev.js";
import type * as devices from "../devices.js";
import type * as enrollment from "../enrollment.js";
import type * as groups from "../groups.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as ioBudgets from "../ioBudgets.js";
import type * as lib_argon from "../lib/argon.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_authCallbacks from "../lib/authCallbacks.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_deepEqual from "../lib/deepEqual.js";
import type * as lib_deviceAuth from "../lib/deviceAuth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_hotkey from "../lib/hotkey.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_members from "../lib/members.js";
import type * as lib_orgRows from "../lib/orgRows.js";
import type * as lib_orgSettings from "../lib/orgSettings.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_publish from "../lib/publish.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_sessions from "../lib/sessions.js";
import type * as lib_stepUp from "../lib/stepUp.js";
import type * as lib_totp from "../lib/totp.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_webauthnConfig from "../lib/webauthnConfig.js";
import type * as maintenance from "../maintenance.js";
import type * as members from "../members.js";
import type * as mfa from "../mfa.js";
import type * as passkeys from "../passkeys.js";
import type * as plans from "../plans.js";
import type * as publish from "../publish.js";
import type * as settings from "../settings.js";
import type * as setup from "../setup.js";
import type * as stepUp from "../stepUp.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  auth: typeof auth;
  crons: typeof crons;
  dev: typeof dev;
  devices: typeof devices;
  enrollment: typeof enrollment;
  groups: typeof groups;
  health: typeof health;
  http: typeof http;
  ioBudgets: typeof ioBudgets;
  "lib/argon": typeof lib_argon;
  "lib/audit": typeof lib_audit;
  "lib/authCallbacks": typeof lib_authCallbacks;
  "lib/authz": typeof lib_authz;
  "lib/crypto": typeof lib_crypto;
  "lib/deepEqual": typeof lib_deepEqual;
  "lib/deviceAuth": typeof lib_deviceAuth;
  "lib/errors": typeof lib_errors;
  "lib/functions": typeof lib_functions;
  "lib/hotkey": typeof lib_hotkey;
  "lib/limits": typeof lib_limits;
  "lib/members": typeof lib_members;
  "lib/orgRows": typeof lib_orgRows;
  "lib/orgSettings": typeof lib_orgSettings;
  "lib/plans": typeof lib_plans;
  "lib/publish": typeof lib_publish;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/sessions": typeof lib_sessions;
  "lib/stepUp": typeof lib_stepUp;
  "lib/totp": typeof lib_totp;
  "lib/validators": typeof lib_validators;
  "lib/webauthnConfig": typeof lib_webauthnConfig;
  maintenance: typeof maintenance;
  members: typeof members;
  mfa: typeof mfa;
  passkeys: typeof passkeys;
  plans: typeof plans;
  publish: typeof publish;
  settings: typeof settings;
  setup: typeof setup;
  stepUp: typeof stepUp;
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
