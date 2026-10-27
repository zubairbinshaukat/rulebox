import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes, type ActionOnly } from "./crypto";

// Argon2id for short secrets (plan D9, Step 5): the device exit PIN (Step 5)
// and the member's action PIN (Step 5a). Same parameters as the agent's
// `kdf.rs`, so a hash made here verifies on a device. Hashing needs random
// salt, so `hashSecret` takes an action context; verifying is deterministic.

export const ARGON2_PARAMS = { memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32 } as const;

/** Argon2id PHC string of `secret` with a 16-byte random salt. Actions only. */
export async function hashSecret(ctx: ActionOnly, secret: string): Promise<string> {
  const salt = randomBytes(ctx, 16);
  return await argon2id({ password: secret, salt, ...ARGON2_PARAMS, outputType: "encoded" });
}

/** True when `secret` matches the PHC string; false for a malformed hash. */
export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: secret, hash: phc });
  } catch {
    return false;
  }
}

/**
 * A hash of a random throwaway value with the same parameters: verifying
 * against it spends the same work as a real check when nothing is stored.
 */
export const DUMMY_PHC = "$argon2id$v=19$m=19456,t=2,p=1$uF0iJaunN1krap1j25xPSw$qBO834XijOyjcz4FlfQ95ZYVe+N4tWksqm/V65CLedM";
