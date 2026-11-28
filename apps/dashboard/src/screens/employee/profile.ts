import { useState } from "react";
import type { EmployeeDetail as Detail } from "../../data/types";
import { generatePassword } from "../../lib/password";
import { employeeStrings as s } from "../../lib/screenStrings/employee";
import { useForm } from "../../lib/useForm";
import * as v from "../../lib/validate";

export type QuotaMode = "default" | "unlimited" | "custom";

export interface ProfileValues extends Record<string, unknown> {
  name: string;
  username: string;
  quotaMode: QuotaMode;
  quota: string;
  groupIds: string[];
  appIds: string[];
  /** New employee only: the generated password, or what the person typed when `typed`. Never stored anywhere but here. */
  password: string;
  typed: boolean;
}

export function valuesOf(d: Detail, isNew: boolean): ProfileValues {
  const q = d.quotaGb;
  return {
    name: d.name,
    username: d.username,
    quotaMode: q === undefined ? "default" : q === 0 ? "unlimited" : "custom",
    quota: q === undefined || q === 0 ? "" : String(q),
    groupIds: d.groupIds,
    appIds: d.appIds,
    password: isNew ? generatePassword() : "",
    typed: false,
  };
}

/** What `employees:save` / `create` take: empty = the organization default, 0 = unlimited. */
export function quotaOf(x: Pick<ProfileValues, "quotaMode" | "quota">): number | undefined {
  if (x.quotaMode === "unlimited") return 0;
  if (x.quotaMode === "custom") return Number(x.quota.trim());
  return undefined;
}

/** "maria.fernanda" from "María Fernanda" (accents and punctuation folded). */
export function suggestUsername(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 40);
}

/**
 * The form's state lives above the card so the Summary beside it can read it live. A new employee starts with a generated password
 * (made once, here); the password is plain component state and goes only to `employees:create`.
 */
export function useProfileForm(d: Detail, isNew: boolean) {
  const [initial] = useState(() => valuesOf(d, isNew));
  return useForm<ProfileValues>(initial, (x) => ({
    name: v.name(x.name, v.NAME_MAX.employee) ?? undefined,
    username: v.username(x.username) ?? undefined,
    quota: x.quotaMode === "custom" ? (v.quota(x.quota) ?? (x.quota.trim() === "" ? s.quotaRequired : undefined)) : undefined,
    password: isNew && x.typed ? (v.employeePassword(x.password, x.username) ?? undefined) : undefined,
  }));
}
export type ProfileFormState = ReturnType<typeof useProfileForm>;

