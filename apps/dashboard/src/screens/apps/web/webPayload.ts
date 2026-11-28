import type { WebAppInput } from "../../../data/types";
import * as v from "../../../lib/validate";
import type { FormValues } from "../appForm";

/**
 * The `apps:createWeb` / `apps:update` payload of the website form. The data model is unchanged: `allowedDomains` is the list of extra
 * entries (lower case, the address's own host left out: the server adds it) and the Rulebox window is no `browser` field at all.
 */
export function webPayload(values: FormValues): WebAppInput {
  return {
    name: values.name.trim(),
    description: values.description.trim() || undefined,
    hue: values.hue,
    url: values.url.trim(),
    allowedDomains: v.lines(values.domains).map((line) => line.toLowerCase()),
    ...(values.browserKind === "edge" ? { browser: { kind: "edge" as const } } : {}),
    ...(values.browserKind === "chrome" ? { browser: { kind: "chrome" as const, appId: values.chromeAppId } } : {}),
  };
}
