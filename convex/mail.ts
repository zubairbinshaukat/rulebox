import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { sendMail } from "./lib/mail";

// The mail sender as an internal action (lib/mail.ts), for mutations: they
// schedule it with `ctx.scheduler.runAfter(0, internal.mail.send, ...)`, so a
// notice goes out only when their transaction commits and a mail failure can
// never fail them. Actions call `sendMail` directly.

export const send = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), reason: v.union(v.literal("mail_off"), v.literal("invalid"), v.literal("failed")) }),
  ),
  handler: async (ctx, args) => await sendMail(ctx, args),
});
