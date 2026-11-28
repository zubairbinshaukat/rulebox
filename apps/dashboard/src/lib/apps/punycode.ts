/**
 * Punycode (RFC 3492) decoding, for DISPLAY only (add-app plan D25): a stored host `xn--bcher-kva.de` is shown as
 * `bücher.de`, with the ASCII form kept in a `title`. Hosts are always stored and compared as ASCII; nothing here is
 * ever used to decide what opens.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitOf(code: number): number {
  if (code >= 48 && code <= 57) return code - 22; // 0-9 -> 26-35
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 97; // a-z
  return BASE;
}

/** Decodes the part of a label after `xn--`. Returns `null` when it is not valid Punycode. */
export function decodePunycode(input: string): string | null {
  const out: number[] = [];
  const basicEnd = input.lastIndexOf("-");
  const basic = basicEnd > 0 ? basicEnd : 0;
  for (let j = 0; j < basic; j++) {
    const code = input.charCodeAt(j);
    if (code >= 128) return null;
    out.push(code);
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const oldI = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitOf(input.charCodeAt(index++));
      if (digit >= BASE) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const length = out.length + 1;
    bias = adapt(i - oldI, length, oldI === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...out);
  } catch {
    return null;
  }
}

/** `xn--bcher-kva.de` -> `bücher.de`. A label that is not valid Punycode stays as it is. */
export function toUnicodeHost(host: string): string {
  return host
    .toLowerCase()
    .split(".")
    .map((label) => {
      if (!label.startsWith("xn--")) return label;
      return decodePunycode(label.slice(4)) ?? label;
    })
    .join(".");
}
