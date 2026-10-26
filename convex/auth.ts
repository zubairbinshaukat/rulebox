import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount, retrieveAccount } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Scrypt } from "lucia";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { beforeSessionCreation, createOrUpdateUser } from "./lib/authCallbacks";
import { codeHash, normalizeEmail, sha256HexSync } from "./lib/crypto";
import { fail } from "./lib/errors";
import { JWT_DURATION_MS, SESSION_INACTIVE_MS, SESSION_TOTAL_MS } from "./lib/limits";
import { consumeOrFail } from "./lib/rateLimits";

// Member sign-in (plan Step 3.1, D3): Convex Auth with ONE credentials
// provider, id "password", flows "signIn" and "signUp" only.
//
// Deviation from the plan (`Password({ profile, ... })`): the Password
// provider calls `profile()` synchronously (it cannot read the database), it
// answers "account exists" / "no such account" with different errors and
// timing, and a sign-up for an existing email reveals that it exists before
// any invite is checked. This provider keeps Convex Auth's Scrypt hashing
// and account functions and adds: a per-email rate limit on every attempt,
// one generic error for every credential failure, a dummy hash check when
// the account does not exist (equal work), and the invite check BEFORE an
// account is looked at.

const scrypt = new Scrypt();

/** Scrypt (lucia format) of a throwaway password; only used to spend equal time. */
const DUMMY_HASH =
  "45e5d40b85f6877eae627ad0272176b0:c33e01b19f8e04072c64ffc7a794dce47d65043841c58228ae26ff04da30f673cce7537e4619359d1124907aefeb892c6603a9487d87a601449806e76056be63";

/** The one answer for a wrong email, wrong password or locked account. */
function invalidCredentials(): never {
  throw new Error("Invalid credentials");
}

/** 12-256 characters with at least one letter and one digit (plan Step 3.1). */
export function validatePasswordRequirements(password: string): void {
  if (
    password.length < 12 ||
    password.length > 256 ||
    !/\p{L}/u.test(password) ||
    !/[0-9]/.test(password)
  ) {
    fail("invalid_argument", { field: "password" });
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const password = ConvexCredentials({
  id: "password",
  authorize: async (params, ctx) => {
    const flow = params.flow;
    if (flow !== "signIn" && flow !== "signUp") invalidCredentials();
    const email = normalizeEmail(str(params.email) ?? "");
    const secret = str(params.password);
    if (email === null || secret === null || secret.length > 256) invalidCredentials();

    // Counted per email whether or not an account exists (1 row write).
    await consumeOrFail(ctx, "signInPerEmail", sha256HexSync(email));

    if (flow === "signUp") {
      validatePasswordRequirements(secret);
      const inviteCode = str(params.inviteCode);
      if (inviteCode === null) fail("invite_invalid");
      const inviteTokenHash = codeHash(inviteCode);
      const usable: boolean = await ctx.runQuery(internal.account.checkJoinInvite, {
        tokenHash: inviteTokenHash,
        email,
      });
      if (!usable) fail("invite_invalid");
      try {
        const { user } = await createAccount(ctx, {
          provider: "password",
          account: { id: email, secret },
          profile: { email, inviteTokenHash },
          shouldLinkViaEmail: false,
          shouldLinkViaPhone: false,
        });
        return { userId: user._id };
      } catch (e) {
        if (e instanceof ConvexError) throw e;
        // "Account <email> already exists" with a different password.
        invalidCredentials();
      }
    }

    try {
      const { user } = await retrieveAccount(ctx, {
        provider: "password",
        account: { id: email, secret },
      });
      return { userId: user._id };
    } catch (e) {
      if (e instanceof Error && e.message === "InvalidAccountId") {
        // No such account: spend the same Scrypt work as a wrong password.
        await scrypt.verify(DUMMY_HASH, secret);
      }
      invalidCredentials();
    }
  },
  crypto: {
    hashSecret: async (secret: string) => await scrypt.hash(secret),
    verifySecret: async (secret: string, hash: string) => await scrypt.verify(hash, secret),
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [password],
  session: { totalDurationMs: SESSION_TOTAL_MS, inactiveDurationMs: SESSION_INACTIVE_MS },
  jwt: { durationMs: JWT_DURATION_MS },
  signIn: { maxFailedAttempsPerHour: 10 }, // the misspelling is the real option name
  callbacks: {
    // Convex Auth types ctx with AnyDataModel; it is this app's mutation ctx.
    createOrUpdateUser: async (ctx, args) =>
      await createOrUpdateUser(ctx as unknown as MutationCtx, args),
    beforeSessionCreation: async (ctx, args) =>
      await beforeSessionCreation(ctx as unknown as MutationCtx, args),
  },
});
