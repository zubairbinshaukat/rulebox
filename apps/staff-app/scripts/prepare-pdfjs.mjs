// Copies the PDF.js data files the viewer needs (character maps, the standard
// fonts, the wasm/JS decoders and the colour profiles) from the installed
// package into `public/pdfjs/`, so the app never fetches them from anywhere
// at runtime (offline-first). Runs before `dev` and `build`; it does nothing
// when the copy is already for this version.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageJson = require.resolve("pdfjs-dist/package.json");
const source = dirname(packageJson);
const { version } = JSON.parse(readFileSync(packageJson, "utf8"));

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "pdfjs");
const marker = join(target, ".version");
const FOLDERS = ["cmaps", "standard_fonts", "wasm", "iccs"];

if (existsSync(marker) && readFileSync(marker, "utf8") === version && FOLDERS.every((f) => existsSync(join(target, f)))) {
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const folder of FOLDERS) {
  if (existsSync(join(source, folder))) {
    cpSync(join(source, folder), join(target, folder), { recursive: true });
  }
}
writeFileSync(marker, version);
console.log(`pdfjs-dist ${version}: data files copied to public/pdfjs`);
