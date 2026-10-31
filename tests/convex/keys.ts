// TEST-ONLY signing keys (plan Step 8). These are the PUBLISHED test vectors
// of RFC 8032 section 7.1 (tests 1 and 2): every Ed25519 implementation knows
// them, so they are obviously not a real key and are safe to commit. Never
// set them on a deployment.

import { hexToBytes } from "@noble/hashes/utils.js";
import type { Id } from "../../convex/_generated/dataModel";
import { base64Encode } from "../../convex/lib/crypto";
import { keyFromSeed, type SigningKey } from "../../convex/lib/signing";
import type { T } from "./identity";

declare const process: { env: Record<string, string | undefined> };

/** RFC 8032 7.1 TEST 1 (also the seed of the committed vectors). */
export const RFC8032_TEST1_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
export const RFC8032_TEST1_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
/** Its signature of the empty message. */
export const RFC8032_TEST1_SIG_HEX =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
/** RFC 8032 7.1 TEST 2: the "other" key of rotation and wrong-key tests. */
export const RFC8032_TEST2_SEED_HEX = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

export const TEST_KEY: SigningKey = keyFromSeed(hexToBytes(RFC8032_TEST1_SEED_HEX));
export const TEST_KEY_2: SigningKey = keyFromSeed(hexToBytes(RFC8032_TEST2_SEED_HEX));
export const TEST_SEED_B64 = base64Encode(TEST_KEY.seed);
export const TEST_SEED_2_B64 = base64Encode(TEST_KEY_2.seed);

/** Put a test seed into the env the functions read (`lib/signing.ts`). Undefined clears it. */
export function setSeeds(active: string | undefined, next?: string): void {
  if (active === undefined) delete process.env.RULEBOX_POLICY_KEY;
  else process.env.RULEBOX_POLICY_KEY = active;
  if (next === undefined) delete process.env.RULEBOX_POLICY_KEY_NEXT;
  else process.env.RULEBOX_POLICY_KEY_NEXT = next;
}

/** The test key as the organization's registered key row. */
export async function insertKeyRow(
  t: T,
  orgId: Id<"organizations">,
  key: SigningKey = TEST_KEY,
  status: "active" | "next" | "retired" = "active",
): Promise<Id<"policyKeys">> {
  return await t.run((ctx) =>
    ctx.db.insert("policyKeys", {
      orgId,
      keyId: key.keyId,
      publicKey: key.publicKeyB64,
      status,
      createdAt: Date.now(),
    }),
  );
}
