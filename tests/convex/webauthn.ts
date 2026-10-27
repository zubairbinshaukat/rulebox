// A software WebAuthn authenticator for convex-test (plan 4.16 tests). It
// builds the same JSON a browser's PublicKeyCredential.toJSON() returns:
// ES256 (P-256) keys from WebCrypto, attestation "none", CBOR via
// @simplewebauthn/server's own encoder. Nothing here proves that a real
// browser or authenticator interoperates; that needs the manual check of
// Step 5a.

import { sha256 } from "@noble/hashes/sha2.js";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const enc = new TextEncoder();

function concat(...parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) {
    out.set(a, i);
    i += a.length;
  }
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function b64u(bytes: Uint8Array): string {
  return isoBase64URL.fromBuffer(new Uint8Array(bytes));
}

/** WebCrypto gives r||s; WebAuthn ES256 signatures are DER. */
function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if ((v[0]! & 0x80) !== 0) v = concat([0], v);
    return concat([0x02, v.length], v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat([0x30, body.length], body);
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export type Ceremony = {
  origin?: string;
  rpId?: string;
  flags?: number;
  counter?: number;
  type?: string;
  /** Sign with this authenticator's key but claim another credential id. */
  credentialId?: string;
  /** Replace the signature with garbage. */
  badSignature?: boolean;
};

export class SoftAuthenticator {
  readonly credentialId: string;
  counter: number;
  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly x: Uint8Array,
    private readonly y: Uint8Array,
    rawId: Uint8Array,
    counter: number,
  ) {
    this.credentialId = b64u(rawId);
    this.counter = counter;
  }

  /** `counter`: 0 for authenticators without a signature counter (synced passkeys). */
  static async create(counter = 1): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const rawId = crypto.getRandomValues(new Uint8Array(16));
    return new SoftAuthenticator(keys, isoBase64URL.toBuffer(jwk.x!), isoBase64URL.toBuffer(jwk.y!), rawId, counter);
  }

  private cose(): Uint8Array {
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(this.x)],
        [-3, new Uint8Array(this.y)],
      ]),
    );
  }

  private clientData(type: string, challenge: string, origin: string): string {
    return b64u(enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
  }

  /** The JSON `finishRegistration` expects, for options from `beginRegistration`. */
  register(optionsJson: string, c: Ceremony = {}): string {
    const options = JSON.parse(optionsJson) as { challenge: string; rp: { id: string } };
    const rpId = c.rpId ?? options.rp.id;
    const rawId = isoBase64URL.toBuffer(this.credentialId);
    const authData = concat(
      sha256(enc.encode(rpId)),
      [(c.flags ?? FLAG_UP | FLAG_UV) | FLAG_AT],
      u32(c.counter ?? this.counter),
      new Uint8Array(16),
      [(rawId.length >> 8) & 255, rawId.length & 255],
      rawId,
      this.cose(),
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return JSON.stringify({
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: this.clientData(c.type ?? "webauthn.create", options.challenge, c.origin ?? ORIGIN),
        attestationObject: b64u(attestationObject),
        transports: ["internal", "made-up"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    });
  }

  /** The JSON `finishVerification` expects. Bumps the counter unless one is given. */
  async assert(optionsJson: string, c: Ceremony = {}): Promise<string> {
    const options = JSON.parse(optionsJson) as { challenge: string; rpId: string };
    const rpId = c.rpId ?? options.rpId;
    if (c.counter === undefined && this.counter > 0) this.counter += 1;
    const authData = concat(sha256(enc.encode(rpId)), [c.flags ?? FLAG_UP | FLAG_UV], u32(c.counter ?? this.counter));
    const clientDataJSON = this.clientData(c.type ?? "webauthn.get", options.challenge, c.origin ?? ORIGIN);
    const signed = concat(authData, sha256(isoBase64URL.toBuffer(clientDataJSON)));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    const signature = c.badSignature === true ? new Uint8Array(72).fill(7) : derSignature(raw);
    const id = c.credentialId ?? this.credentialId;
    return JSON.stringify({
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
    });
  }
}

export const RP_ID = "localhost";
export const ORIGIN = "http://localhost:5173";
