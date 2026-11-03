#!/usr/bin/env node
// Platform secrets helper (Phase 4b Part C). The interim stand-in for the
// operator console: run by the OWNER personally, on their own machine.
//
//   AGENTS (Claude, CI, any automation) MUST NEVER RUN THIS SCRIPT: it handles
//   live credentials (the Resend API key) and the master key of a deployment.
//
//   node scripts/platform-secret.mjs generate-key --out .tmp/platform.key
//   node scripts/platform-secret.mjs set <name> --key-file .tmp/platform.key [--prod]
//   node scripts/platform-secret.mjs clear <name> [--prod]
//   node scripts/platform-secret.mjs status [--prod]
//   node scripts/platform-secret.mjs check [--prod]
//
// Names: resendApiKey, resendFrom ("Rulebox <no-reply@your.domain>"),
// dashboardOrigin ("https://dashboard.your.domain").
//
// `generate-key` writes a new master key (standard base64 of 32 random
// bytes, one line) to a file it never overwrites, and prints nothing secret.
// Set the file's only line as the deployment env RULEBOX_PLATFORM_KEY (Convex
// dashboard -> Settings -> Environment Variables), keep the file somewhere
// safe (it is needed to set secrets later) and never commit or paste it.
//
// `set` reads the VALUE from a hidden prompt (or from stdin when piped), never
// from the command line, encrypts it HERE with the master key from
// --key-file (AES-256-GCM, a random IV, the name as additional data: the same
// format as convex/lib/platformSecrets.ts), and stores only the ciphertext
// with `convex run platform:storeSecret`. The plaintext never appears in a
// process list, a shell history or the Convex logs. `check` asks the
// deployment to decrypt every stored secret and answers set / decrypts only.

import { pathToFileURL } from "node:url";

export const NAMES = ["resendApiKey", "resendFrom", "dashboardOrigin"];

const USAGE =
  "usage: node scripts/platform-secret.mjs generate-key --out <file>\n" +
  "       node scripts/platform-secret.mjs set <name> --key-file <file> [--prod]\n" +
  "       node scripts/platform-secret.mjs clear <name> [--prod]\n" +
  "       node scripts/platform-secret.mjs status [--prod]\n" +
  "       node scripts/platform-secret.mjs check [--prod]\n" +
  `names: ${NAMES.join(", ")}`;

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** The 32 key bytes of a master key text (standard base64), or throws. */
export function parseMasterKey(text) {
  const t = text.trim();
  const bytes = Buffer.from(t, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== t) throw new Error("the master key must be standard base64 of exactly 32 bytes");
  return new Uint8Array(bytes);
}

/** A new master key (standard base64 of 32 random bytes). */
export function generateMasterKey() {
  return b64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Encrypt `value` for `name` exactly like convex/lib/platformSecrets.ts `sealSecret`. */
export async function seal(masterKeyB64, name, value) {
  const raw = parseMasterKey(masterKeyB64);
  const key = await globalThis.crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`rulebox.platformSecret.v1:${name}`);
  const out = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, new TextEncoder().encode(value));
  return { ciphertext: b64(new Uint8Array(out)), iv: b64(iv) };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Read one value: hidden prompt on a terminal, else all of stdin (one trailing newline dropped). */
async function readValue(prompt) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let value = "";
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      fn();
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    }
    stdin.on("data", onData);
  });
}

/** Run `convex run <fn> <json> [--prod]` with node directly (no shell: the JSON is passed intact). */
async function convexRun(fn, args, prod) {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("convex/package.json")), "bin", "main.js");
  const argv = [cli, "run", fn, JSON.stringify(args)];
  if (prod) argv.push("--prod");
  const r = spawnSync(process.execPath, argv, { stdio: "inherit" });
  return r.status ?? 1;
}

/**
 * CLI. Returns the process exit code. `io` is for tests: `out` / `err` lines,
 * `readValue(prompt)`, `run(fn, args, prod)` (defaults: console, the hidden
 * prompt, `convex run`).
 */
export async function main(argv, io = {}) {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  const read = io.readValue ?? readValue;
  const run = io.run ?? convexRun;
  const [command, name] = argv;
  const prod = argv.includes("--prod");
  const { readFileSync, writeFileSync } = await import("node:fs");

  if (command === "generate-key") {
    const path = arg(argv, "--out");
    if (path === undefined) {
      err(USAGE);
      return 2;
    }
    try {
      writeFileSync(path, `${generateMasterKey()}\n`, { flag: "wx", mode: 0o600 });
    } catch (e) {
      err(e?.code === "EEXIST" ? `refusing to overwrite ${path}` : `could not write ${path}`);
      return 1;
    }
    out(`Wrote a new master key to ${path}. Set its only line as RULEBOX_PLATFORM_KEY on the deployment.`);
    out("Keep the file private (needed to set secrets later); never commit, paste or log it.");
    return 0;
  }
  if (command === "set") {
    const keyFile = arg(argv, "--key-file");
    if (!NAMES.includes(name) || keyFile === undefined) {
      err(USAGE);
      return 2;
    }
    let masterKey;
    try {
      masterKey = readFileSync(keyFile, "utf8");
      parseMasterKey(masterKey);
    } catch {
      err(`${keyFile} does not hold a master key (standard base64 of 32 bytes)`);
      return 1;
    }
    let value;
    try {
      value = await read(`Value for ${name} (hidden): `);
    } catch {
      err("cancelled");
      return 1;
    }
    if (value.length === 0 || value !== value.trim()) {
      err("refused: empty, or leading / trailing whitespace");
      return 1;
    }
    const sealed = await seal(masterKey, name, value);
    const code = await run("platform:storeSecret", { name, ...sealed }, prod);
    if (code === 0) out(`Stored ${name} (encrypted). Run "check" to confirm the deployment can decrypt it.`);
    return code;
  }
  if (command === "clear") {
    if (!NAMES.includes(name)) {
      err(USAGE);
      return 2;
    }
    return await run("platform:clearSecret", { name }, prod);
  }
  if (command === "status") return await run("platform:status", {}, prod);
  if (command === "check") return await run("platform:checkSecrets", {}, prod);
  err(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
