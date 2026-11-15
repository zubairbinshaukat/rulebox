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
import type * as apps from "../apps.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as broadcasts from "../broadcasts.js";
import type * as crons from "../crons.js";
import type * as deviceApi from "../deviceApi.js";
import type * as devices from "../devices.js";
import type * as drivers from "../drivers.js";
import type * as employees from "../employees.js";
import type * as enrollment from "../enrollment.js";
import type * as enrollmentCodes from "../enrollmentCodes.js";
import type * as fileHandlers from "../fileHandlers.js";
import type * as fleet from "../fleet.js";
import type * as groups from "../groups.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as ioBudgets from "../ioBudgets.js";
import type * as keys from "../keys.js";
import type * as lib_appPublish from "../lib/appPublish.js";
import type * as lib_appRules from "../lib/appRules.js";
import type * as lib_argon from "../lib/argon.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_authCallbacks from "../lib/authCallbacks.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_deepEqual from "../lib/deepEqual.js";
import type * as lib_denyList from "../lib/denyList.js";
import type * as lib_desired from "../lib/desired.js";
import type * as lib_deviceApiRules from "../lib/deviceApiRules.js";
import type * as lib_deviceAuth from "../lib/deviceAuth.js";
import type * as lib_deviceReport from "../lib/deviceReport.js";
import type * as lib_employeeRules from "../lib/employeeRules.js";
import type * as lib_employeeSync from "../lib/employeeSync.js";
import type * as lib_enrollmentCodes from "../lib/enrollmentCodes.js";
import type * as lib_driverRules from "../lib/driverRules.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_fleet from "../lib/fleet.js";
import type * as lib_groupConfig from "../lib/groupConfig.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_hostRules from "../lib/hostRules.js";
import type * as lib_hotkey from "../lib/hotkey.js";
import type * as lib_installs from "../lib/installs.js";
import type * as lib_keyring from "../lib/keyring.js";
import type * as lib_lifecycle from "../lib/lifecycle.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_listing from "../lib/listing.js";
import type * as lib_lockdownReports from "../lib/lockdownReports.js";
import type * as lib_lockdownValidators from "../lib/lockdownValidators.js";
import type * as lib_mail from "../lib/mail.js";
import type * as lib_members from "../lib/members.js";
import type * as lib_networkShared from "../lib/networkShared.js";
import type * as lib_noticeText from "../lib/noticeText.js";
import type * as lib_orgDb from "../lib/orgDb.js";
import type * as lib_orgRows from "../lib/orgRows.js";
import type * as lib_orgSettings from "../lib/orgSettings.js";
import type * as lib_pathRules from "../lib/pathRules.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_platformSecrets from "../lib/platformSecrets.js";
import type * as lib_policyKeys from "../lib/policyKeys.js";
import type * as lib_presence from "../lib/presence.js";
import type * as lib_printerAddress from "../lib/printerAddress.js";
import type * as lib_printerDrivers from "../lib/printerDrivers.js";
import type * as lib_publish from "../lib/publish.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_recoveryCodes from "../lib/recoveryCodes.js";
import type * as lib_retry from "../lib/retry.js";
import type * as lib_roster from "../lib/roster.js";
import type * as lib_safeFetch from "../lib/safeFetch.js";
import type * as lib_sealbox from "../lib/sealbox.js";
import type * as lib_sessions from "../lib/sessions.js";
import type * as lib_signing from "../lib/signing.js";
import type * as lib_stepUp from "../lib/stepUp.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_webauthnConfig from "../lib/webauthnConfig.js";
import type * as lib_webmeta from "../lib/webmeta.js";
import type * as lib_winget from "../lib/winget.js";
import type * as mail from "../mail.js";
import type * as maintenance from "../maintenance.js";
import type * as members from "../members.js";
import type * as networks from "../networks.js";
import type * as overview from "../overview.js";
import type * as passkeys from "../passkeys.js";
import type * as plans from "../plans.js";
import type * as platform from "../platform.js";
import type * as presence from "../presence.js";
import type * as publish from "../publish.js";
import type * as seal from "../seal.js";
import type * as security from "../security.js";
import type * as settings from "../settings.js";
import type * as setup from "../setup.js";
import type * as stats from "../stats.js";
import type * as stepUp from "../stepUp.js";
import type * as testing from "../testing.js";
import type * as wifi from "../wifi.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  apps: typeof apps;
  audit: typeof audit;
  auth: typeof auth;
  broadcasts: typeof broadcasts;
  crons: typeof crons;
  deviceApi: typeof deviceApi;
  devices: typeof devices;
  drivers: typeof drivers;
  employees: typeof employees;
  enrollment: typeof enrollment;
  enrollmentCodes: typeof enrollmentCodes;
  fileHandlers: typeof fileHandlers;
  fleet: typeof fleet;
  groups: typeof groups;
  health: typeof health;
  http: typeof http;
  ioBudgets: typeof ioBudgets;
  keys: typeof keys;
  "lib/appPublish": typeof lib_appPublish;
  "lib/appRules": typeof lib_appRules;
  "lib/argon": typeof lib_argon;
  "lib/audit": typeof lib_audit;
  "lib/authCallbacks": typeof lib_authCallbacks;
  "lib/authz": typeof lib_authz;
  "lib/crypto": typeof lib_crypto;
  "lib/deepEqual": typeof lib_deepEqual;
  "lib/denyList": typeof lib_denyList;
  "lib/desired": typeof lib_desired;
  "lib/deviceApiRules": typeof lib_deviceApiRules;
  "lib/deviceAuth": typeof lib_deviceAuth;
  "lib/deviceReport": typeof lib_deviceReport;
  "lib/employeeRules": typeof lib_employeeRules;
  "lib/employeeSync": typeof lib_employeeSync;
  "lib/enrollmentCodes": typeof lib_enrollmentCodes;
  "lib/driverRules": typeof lib_driverRules;
  "lib/errors": typeof lib_errors;
  "lib/fleet": typeof lib_fleet;
  "lib/groupConfig": typeof lib_groupConfig;
  "lib/functions": typeof lib_functions;
  "lib/hostRules": typeof lib_hostRules;
  "lib/hotkey": typeof lib_hotkey;
  "lib/installs": typeof lib_installs;
  "lib/keyring": typeof lib_keyring;
  "lib/lifecycle": typeof lib_lifecycle;
  "lib/limits": typeof lib_limits;
  "lib/listing": typeof lib_listing;
  "lib/lockdownReports": typeof lib_lockdownReports;
  "lib/lockdownValidators": typeof lib_lockdownValidators;
  "lib/mail": typeof lib_mail;
  "lib/members": typeof lib_members;
  "lib/networkShared": typeof lib_networkShared;
  "lib/noticeText": typeof lib_noticeText;
  "lib/orgDb": typeof lib_orgDb;
  "lib/orgRows": typeof lib_orgRows;
  "lib/orgSettings": typeof lib_orgSettings;
  "lib/pathRules": typeof lib_pathRules;
  "lib/plans": typeof lib_plans;
  "lib/platformSecrets": typeof lib_platformSecrets;
  "lib/policyKeys": typeof lib_policyKeys;
  "lib/presence": typeof lib_presence;
  "lib/printerAddress": typeof lib_printerAddress;
  "lib/printerDrivers": typeof lib_printerDrivers;
  "lib/publish": typeof lib_publish;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/recoveryCodes": typeof lib_recoveryCodes;
  "lib/retry": typeof lib_retry;
  "lib/roster": typeof lib_roster;
  "lib/safeFetch": typeof lib_safeFetch;
  "lib/sealbox": typeof lib_sealbox;
  "lib/sessions": typeof lib_sessions;
  "lib/signing": typeof lib_signing;
  "lib/stepUp": typeof lib_stepUp;
  "lib/validators": typeof lib_validators;
  "lib/webauthnConfig": typeof lib_webauthnConfig;
  "lib/webmeta": typeof lib_webmeta;
  "lib/winget": typeof lib_winget;
  mail: typeof mail;
  maintenance: typeof maintenance;
  members: typeof members;
  networks: typeof networks;
  overview: typeof overview;
  passkeys: typeof passkeys;
  plans: typeof plans;
  platform: typeof platform;
  presence: typeof presence;
  publish: typeof publish;
  seal: typeof seal;
  security: typeof security;
  settings: typeof settings;
  setup: typeof setup;
  stats: typeof stats;
  stepUp: typeof stepUp;
  testing: typeof testing;
  wifi: typeof wifi;
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
