import { describe, expect, it } from "vitest";
import { inspectDriverZip, listZip, MAX_INFS_LISTED, MAX_INFS_READ, modelsOfInf, modelsOfInfPath, readEntry, ZipError, type ZipProblem } from "./zipInspect";

// Zips are built here, byte by byte (a stored entry, a deflate entry, nested paths, a comment, the odd ones the reader must refuse).

interface Item {
  name: string;
  data?: Uint8Array | string;
  method?: 0 | 8;
  flags?: number;
  /** Raw bytes stored as the entry's data (a broken deflate stream, for instance). */
  raw?: Uint8Array;
  declaredSize?: number;
}
interface Options {
  comment?: string;
  zip64Locator?: boolean;
  entriesField?: number;
  diskField?: number;
  sizeField?: number;
}

const enc = new TextEncoder();
const bytes = (d: Uint8Array | string | undefined) => (d === undefined ? new Uint8Array() : typeof d === "string" ? enc.encode(d) : d);

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** A valid raw-deflate stream made of stored blocks (no compression): the inflater still runs, and the test needs no zlib. */
function deflateStored(data: Uint8Array): Uint8Array {
  const parts: number[][] = [];
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < Math.max(data.length, 1); at += 65_535) chunks.push(data.subarray(at, Math.min(data.length, at + 65_535)));
  chunks.forEach((c, i) => {
    parts.push([i === chunks.length - 1 ? 1 : 0, ...u16(c.length), ...u16(~c.length & 0xffff)]);
  });
  const out: number[] = [];
  chunks.forEach((c, i) => {
    out.push(...parts[i]!);
    for (const b of c) out.push(b);
  });
  return Uint8Array.from(out);
}

/** Real compression through the browser API, for the one test that needs a small stream that inflates huge. */
async function deflateReal(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function makeZip(items: Item[], o: Options = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const add = (...chunks: (number[] | Uint8Array)[]) => {
    for (const c of chunks) {
      const part = c instanceof Uint8Array ? c : Uint8Array.from(c);
      parts.push(part);
      length += part.length;
    }
  };
  const central: number[] = [];
  for (const item of items) {
    const name = [...enc.encode(item.name)];
    const method = item.method ?? 0;
    const plain = bytes(item.data);
    const stored = item.raw ?? (method === 8 ? deflateStored(plain) : plain);
    const size = item.declaredSize ?? plain.length;
    const offset = length;
    add([...u32(0x04034b50), ...u16(20), ...u16(item.flags ?? 0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(stored.length), ...u32(size), ...u16(name.length), ...u16(0), ...name], stored);
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(item.flags ?? 0), ...u16(method), ...u16(0), ...u16(0), ...u32(0),
      ...u32(stored.length), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    );
  }
  const directoryOffset = length;
  add(central);
  const comment = [...enc.encode(o.comment ?? "")];
  if (o.zip64Locator) add([...u32(0x07064b50), ...u32(0), ...u32(0), ...u32(0), ...u32(1)]); // 20 bytes: signature, disk, 8-byte offset, disks
  add([
    ...u32(0x06054b50), ...u16(o.diskField ?? 0), ...u16(0), ...u16(o.entriesField ?? items.length), ...u16(o.entriesField ?? items.length),
    ...u32(o.sizeField ?? central.length), ...u32(directoryOffset), ...u16(comment.length), ...comment,
  ]);
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const file = (zip: Uint8Array, name = "driver.zip") => new File([zip as Uint8Array<ArrayBuffer>], name, { type: "application/zip" });

async function problemOf(promise: Promise<unknown>): Promise<ZipProblem | "no error"> {
  try {
    await promise;
    return "no error";
  } catch (e) {
    if (e instanceof ZipError) return e.code;
    throw e;
  }
}

const INF = (models: string[]) => `[Manufacturer]\n%V% = M, NTamd64\n[M.NTamd64]\n${models.map((m) => `"${m}" = Install`).join("\n")}\n`;

describe("listZip", () => {
  it("lists stored and deflated entries, nested paths and directories", async () => {
    const zip = makeZip([
      { name: "readme.txt", data: "hello" },
      { name: "drivers/" },
      { name: "drivers/x64/printer.inf", data: INF(["A"]), method: 8 },
      { name: "drivers/x64/printer.cat", data: "cat" },
    ]);
    const entries = await listZip(file(zip));
    expect(entries.map((e) => [e.path, e.method, e.directory])).toEqual([
      ["readme.txt", 0, false],
      ["drivers/", 0, true],
      ["drivers/x64/printer.inf", 8, false],
      ["drivers/x64/printer.cat", 0, false],
    ]);
    expect(entries[2]!.size).toBe(INF(["A"]).length);
    expect(entries[2]!.compressedSize).toBeLessThan(entries[2]!.size + 20);
  });

  it("finds the end record behind a long comment, and ignores a signature inside the comment", async () => {
    const trap = String.fromCharCode(0x50, 0x4b, 0x05, 0x06) + "x".repeat(40);
    const zip = makeZip([{ name: "a.inf", data: INF(["A"]) }], { comment: `${trap} ${"c".repeat(60_000)}` });
    expect((await listZip(file(zip))).map((e) => e.path)).toEqual(["a.inf"]);
  });

  it("turns backslashes into slashes", async () => {
    const entries = await listZip(file(makeZip([{ name: "win\\x64\\p.inf", data: INF(["A"]) }])));
    expect(entries[0]!.path).toBe("win/x64/p.inf");
  });

  it("refuses what it cannot read, with the reason", async () => {
    const good = [{ name: "a.inf", data: INF(["A"]) }];
    expect(await problemOf(listZip(file(new Uint8Array(0))))).toBe("not_zip");
    expect(await problemOf(listZip(file(enc.encode("not a zip at all, just text, long enough to search"))))).toBe("not_zip");
    expect(await problemOf(listZip(file(makeZip(good).slice(0, -5))))).toBe("not_zip"); // the end record is cut off
    expect(await problemOf(listZip(file(makeZip(good, { zip64Locator: true }))))).toBe("zip64");
    expect(await problemOf(listZip(file(makeZip(good, { entriesField: 0xffff }))))).toBe("zip64");
    expect(await problemOf(listZip(file(makeZip(good, { sizeField: 0xffffffff }))))).toBe("zip64");
    expect(await problemOf(listZip(file(makeZip(good, { diskField: 1 }))))).toBe("multi_disk");
    expect(await problemOf(listZip(file(makeZip([{ name: "secret.inf", data: "x", flags: 1 }]))))).toBe("encrypted");
    expect(await problemOf(listZip(file(makeZip([...good, { name: "other.bin", data: "x", flags: 1 }]))))).toBe("encrypted");
    expect(await problemOf(listZip(file(makeZip(good, { entriesField: 3 }))))).toBe("unreadable"); // the directory has fewer entries than it says
    // A central directory that points past the end of the file.
    const broken = makeZip(good);
    new DataView(broken.buffer).setUint32(broken.length - 6, 0x7fffffff, true);
    expect(await problemOf(listZip(file(broken)))).toBe("unreadable");
  });
});

describe("readEntry and modelsOfInf", () => {
  it("opens stored and deflated entries", async () => {
    const f = file(makeZip([{ name: "a.txt", data: "stored text" }, { name: "b.txt", data: "deflated ".repeat(200), method: 8 }]));
    const [a, b] = await listZip(f);
    expect(new TextDecoder().decode((await readEntry(f, a!))!)).toBe("stored text");
    expect(new TextDecoder().decode((await readEntry(f, b!))!)).toBe("deflated ".repeat(200));
  });

  it("answers null for a directory, an unknown method, a too big entry and a broken stream", async () => {
    const f = file(
      makeZip([
        { name: "dir/" },
        { name: "odd.bin", data: "x", method: 8, raw: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
        { name: "big.inf", data: "a".repeat(2_000), method: 8 },
        { name: "lie.inf", data: "tiny", method: 8, declaredSize: 5 },
      ]),
    );
    const [dir, broken, big, lie] = await listZip(f);
    expect(await readEntry(f, dir!)).toBeNull();
    expect(await readEntry(f, { ...dir!, directory: false, method: 12 })).toBeNull();
    expect(await readEntry(f, broken!)).toBeNull();
    expect(await readEntry(f, big!, 1_000)).toBeNull(); // declared size over the limit
    // A declared size that lies about a bomb: the output is cut at the limit.
    const bomb = file(makeZip([{ name: "bomb.inf", method: 8, raw: await deflateReal(enc.encode("a".repeat(5_000_000))), declaredSize: 10 }]));
    const [b0] = await listZip(bomb);
    expect(await readEntry(bomb, b0!, 100_000)).toBeNull();
    expect(lie).toBeDefined();
  });

  it("models of an INF entry, read from stored and deflated data", async () => {
    const f = file(
      makeZip([
        { name: "a.inf", data: INF(["Printer A", "Printer B"]), method: 8 },
        { name: "b.inf", data: INF(["Printer C"]) },
        { name: "junk.inf", data: "not really an inf" },
      ]),
    );
    const [a, b, junk] = await listZip(f);
    expect(await modelsOfInf(f, a!)).toEqual(["Printer A", "Printer B"]);
    expect(await modelsOfInf(f, b!)).toEqual(["Printer C"]);
    expect(await modelsOfInf(f, junk!)).toEqual([]);
    expect(await modelsOfInfPath(f, "b.inf")).toEqual(["Printer C"]);
    expect(await modelsOfInfPath(f, "nope.inf")).toEqual([]);
  });
});

describe("inspectDriverZip", () => {
  it("lists the INF files shallowest first, with their models", async () => {
    const f = file(
      makeZip([
        { name: "Drivers/Win10/x64/zeta.inf", data: INF(["Deep"]), method: 8 },
        { name: "setup.exe", data: "MZ" },
        { name: "alpha.inf", data: INF(["Alpha One", "Alpha Two"]) },
        { name: "Drivers/Win10/x64/readme.txt", data: "x" },
        { name: "Drivers/beta.INF", data: INF(["Beta"]), method: 8 },
        { name: "Drivers/", },
      ]),
    );
    const r = await inspectDriverZip(f);
    expect(r.entryCount).toBe(6);
    expect(r.moreInfs).toBe(false);
    expect(r.infs).toEqual([
      { path: "alpha.inf", models: ["Alpha One", "Alpha Two"] },
      { path: "Drivers/beta.INF", models: ["Beta"] },
      { path: "Drivers/Win10/x64/zeta.inf", models: ["Deep"] },
    ]);
  });

  it("a zip without an INF has an empty list", async () => {
    const r = await inspectDriverZip(file(makeZip([{ name: "readme.txt", data: "x" }, { name: "setup.exe", data: "MZ" }])));
    expect(r).toEqual({ entryCount: 2, infs: [], moreInfs: false });
  });

  it("only lists paths the server accepts for the INF field", async () => {
    const f = file(
      makeZip([
        { name: "ok.inf", data: INF(["Ok"]) },
        { name: "../evil.inf", data: INF(["Evil"]) },
        { name: "/abs.inf", data: INF(["Abs"]) },
        { name: "C:/drive.inf", data: INF(["Drive"]) },
        { name: "a/./b.inf", data: INF(["Dot"]) },
        { name: `${"d/".repeat(70)}long.inf`, data: INF(["Long"]) },
        { name: "folder.inf/", },
        { name: "notinf.inf.txt", data: "x" },
      ]),
    );
    expect((await inspectDriverZip(f)).infs.map((i) => i.path)).toEqual(["ok.inf"]);
  });

  it("reads models for the first few INF files only; the rest are listed and can be read on demand", async () => {
    const items: Item[] = [];
    for (let i = 0; i < MAX_INFS_READ + 3; i++) items.push({ name: `d${String(i).padStart(2, "0")}.inf`, data: INF([`Model ${i}`]) });
    const f = file(makeZip(items));
    const r = await inspectDriverZip(f);
    expect(r.infs).toHaveLength(MAX_INFS_READ + 3);
    expect(r.infs.slice(0, MAX_INFS_READ).every((x) => x.models !== null && x.models.length === 1)).toBe(true);
    expect(r.infs.slice(MAX_INFS_READ).map((x) => x.models)).toEqual([null, null, null]);
    expect(await modelsOfInfPath(f, `d${String(MAX_INFS_READ + 1).padStart(2, "0")}.inf`)).toEqual([`Model ${MAX_INFS_READ + 1}`]);
  });

  it("lists at most 200 INF files and says there were more", async () => {
    const items: Item[] = [];
    for (let i = 0; i < MAX_INFS_LISTED + 5; i++) items.push({ name: `f${String(i).padStart(3, "0")}.inf`, data: "" });
    const r = await inspectDriverZip(file(makeZip(items)));
    expect(r.infs).toHaveLength(MAX_INFS_LISTED);
    expect(r.moreInfs).toBe(true);
    expect(r.entryCount).toBe(MAX_INFS_LISTED + 5);
  });

  it("an INF that is too big or broken gives no models, but is still listed", async () => {
    const f = file(
      makeZip([
        { name: "big.inf", data: `${INF(["Big"])}${";".repeat(1_100_000)}`, method: 8 },
        { name: "broken.inf", data: "x", method: 8, raw: new Uint8Array([9, 9, 9, 9]) },
      ]),
    );
    expect((await inspectDriverZip(f)).infs).toEqual([
      { path: "big.inf", models: [] },
      { path: "broken.inf", models: [] },
    ]);
  });

  it("throws the zip's problem", async () => {
    expect(await problemOf(inspectDriverZip(file(enc.encode("hello world, not a zip file at all"))))).toBe("not_zip");
    expect(await problemOf(inspectDriverZip(file(makeZip([{ name: "a.inf", data: "x", flags: 1 }]))))).toBe("encrypted");
  });

  it("does not read the whole file: only the end, the directory and the INF entries are sliced", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(7);
    const zip = makeZip([
      { name: "payload.bin", data: big },
      { name: "p.inf", data: INF(["Only"]), method: 8 },
      { name: "more.bin", data: big },
    ]);
    const inner = file(zip);
    let requested = 0;
    const spy = {
      size: inner.size,
      slice: (start?: number, end?: number) => {
        const piece = inner.slice(start, end);
        requested += piece.size;
        return piece;
      },
    } as unknown as Blob;
    const r = await inspectDriverZip(spy);
    expect(r.infs).toEqual([{ path: "p.inf", models: ["Only"] }]);
    expect(inner.size).toBeGreaterThan(6 * 1024 * 1024);
    expect(requested).toBeLessThan(200 * 1024);
  });
});
