/**
 * A generated first password for an employee (other-pages plan 0 and decision 16/17).
 *
 * 12 characters from an alphabet without look-alikes (no 0 o 1 l i), shown in groups of four with dashes,
 * `k7mq-p4xt-9wrb`. The dashes are part of the password (14 characters), so what is read out and typed
 * is what is stored. Always passes `v.employeePassword` (8 to 256 characters, not the user name).
 *
 * Random bytes come from `crypto.getRandomValues`, never `Math.random`. A byte is used only when it is
 * below the largest multiple of the alphabet size, so every character is equally likely (no modulo bias).
 */

/** 31 characters: lower case and digits without `i`, `l`, `o`, `0` and `1`. */
export const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** Characters drawn from the alphabet (the dashes come on top). */
export const PASSWORD_LENGTH = 12;
export const PASSWORD_GROUP = 4;

/** The largest multiple of the alphabet size that fits in a byte; bytes at or above it are thrown away. */
const LIMIT = 256 - (256 % PASSWORD_ALPHABET.length);

/** `n` characters from the alphabet, uniformly. */
function randomChars(n: number): string {
  let out = "";
  while (out.length < n) {
    const bytes = new Uint8Array((n - out.length) * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < LIMIT && out.length < n) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

/** A new password such as `k7mq-p4xt-9wrb`. */
export function generatePassword(): string {
  const chars = randomChars(PASSWORD_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += PASSWORD_GROUP) groups.push(chars.slice(i, i + PASSWORD_GROUP));
  return groups.join("-");
}
