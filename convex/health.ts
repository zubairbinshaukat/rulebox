import { v } from "convex/values";
import { publicQuery } from "./lib/functions";

export const ping = publicQuery({
  args: {},
  returns: v.object({ ok: v.boolean(), at: v.number() }),
  handler: async () => {
    return { ok: true, at: Date.now() };
  },
});
