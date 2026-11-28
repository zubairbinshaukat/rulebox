import { describe, expect, it } from "vitest";
import type { Column } from "../components/DataTable";
import { cardLayout, cardRole, columnType, sortOptions, tableColumns } from "./cardLayout";

interface Row {
  id: string;
}
const col = (key: string, over: Partial<Column<Row>> = {}): Column<Row> => ({ key, header: key[0]!.toUpperCase() + key.slice(1), cell: () => key, ...over });

describe("cardLayout: roles", () => {
  it("defaults: primary is the title, actions the footer, everything else a fact", () => {
    const name = col("name", { primary: true });
    const when = col("when");
    const act = col("act", { actions: true });
    expect(cardRole(name)).toBe("title");
    expect(cardRole(act)).toBe("actions");
    expect(cardRole(when)).toBe("fact");
    const layout = cardLayout([name, when, act]);
    expect(layout.title).toBe(name);
    expect(layout.facts).toEqual([when]);
    expect(layout.actions).toBe(act);
    expect(layout.status).toEqual([]);
    expect(layout.details).toEqual([]);
    expect(layout.subtitle).toBeUndefined();
  });

  it("sorts explicit roles into their slots, in column order; hidden columns are dropped", () => {
    const columns = [
      col("name", { primary: true, cardSub: () => "sub line" }),
      col("state", { card: "status" }),
      col("kiosk", { card: "status" }),
      col("policy", { card: "fact" }),
      col("build", { card: "detail" }),
      col("created", { card: "hidden" }),
    ];
    const layout = cardLayout(columns);
    expect(layout.status.map((c) => c.key)).toEqual(["state", "kiosk"]);
    expect(layout.facts.map((c) => c.key)).toEqual(["policy"]);
    expect(layout.details.map((c) => c.key)).toEqual(["build"]);
    expect(layout.subtitle?.render({ id: "1" })).toBe("sub line");
  });

  it("a subtitle column becomes the subtitle", () => {
    const layout = cardLayout([col("name", { primary: true }), col("user", { card: "subtitle", cell: () => "jdoe" })]);
    expect(layout.subtitle?.render({ id: "1" })).toBe("jdoe");
    expect(layout.facts).toEqual([]);
  });

  it("shows at most four facts; the rest become details in column order", () => {
    const columns = [col("name", { primary: true }), col("a"), col("b"), col("c"), col("d"), col("e"), col("f", { card: "detail" })];
    const layout = cardLayout(columns);
    expect(layout.facts.map((c) => c.key)).toEqual(["a", "b", "c", "d"]);
    expect(layout.details.map((c) => c.key)).toEqual(["e", "f"]);
  });

  it("a list without a title column cannot be cards (a screen bug, thrown in development)", () => {
    expect(() => cardLayout([col("a"), col("b")])).toThrow(/title/);
  });

  it("card-only columns (table: false) are left out of the table", () => {
    const columns = [col("name", { primary: true }), col("group", { table: false, card: "subtitle" }), col("when")];
    expect(tableColumns(columns).map((c) => c.key)).toEqual(["name", "when"]);
    expect(cardLayout(columns).subtitle).toBeDefined();
  });
});

describe("columnType", () => {
  it("is declared, or derived from primary / actions / numeric; a column that says nothing is short (never wraps)", () => {
    expect(columnType(col("a", { type: "mono" }))).toBe("mono");
    expect(columnType(col("a", { primary: true }))).toBe("name");
    expect(columnType(col("a", { actions: true }))).toBe("actions");
    expect(columnType(col("a", { numeric: true }))).toBe("num");
    expect(columnType(col("a", { nowrap: true }))).toBe("short");
    expect(columnType(col("a"))).toBe("short");
  });
});

describe("sortOptions", () => {
  it("names the directions in plain words by the kind of column, the first-click direction first", () => {
    const columns = [
      col("name", { primary: true, sortable: true }),
      col("created", { header: "Enrolled", type: "date", sortable: true, sortDefaultDir: "desc" }),
      col("pcs", { header: "PCs", type: "num", sortable: true }),
      col("plain"),
    ];
    expect(sortOptions(columns).map((o) => [o.value, o.label])).toEqual([
      ["name:asc", "Name: A to Z"],
      ["name:desc", "Name: Z to A"],
      ["created:desc", "Enrolled: newest first"],
      ["created:asc", "Enrolled: oldest first"],
      ["pcs:desc", "PCs: most first"],
      ["pcs:asc", "PCs: fewest first"],
    ]);
  });

  it("puts the default order that has no column first", () => {
    const options = sortOptions([col("name", { primary: true, sortable: true })], { key: "created", dir: "desc", label: "Newest first" });
    expect(options[0]).toMatchObject({ value: "created:desc", label: "Newest first" });
    expect(options).toHaveLength(3);
  });

  it("uses cardLabel as the column's name and skips action columns", () => {
    const options = sortOptions([col("username", { header: "Username", cardLabel: "Sign-in name", sortable: true }), col("act", { actions: true, sortable: true })]);
    expect(options.map((o) => o.label)).toEqual(["Sign-in name: A to Z", "Sign-in name: Z to A"]);
  });
});
