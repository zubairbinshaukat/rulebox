// The only part of Node's `fs` the tests use (the app has no @types/node: nothing in the app itself touches the disk).
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
