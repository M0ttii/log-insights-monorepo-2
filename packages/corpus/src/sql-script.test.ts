import { describe, expect, it } from "vitest"

import { fillPlaceholders, splitSqlScript } from "./sql-script.ts"

describe("splitSqlScript", () => {
  it("splits on statement ends and drops line comments", () => {
    const script = `-- header
CREATE TABLE a AS SELECT 1; -- trailing
SELECT 2;

`
    expect(splitSqlScript(script)).toEqual([
      "CREATE TABLE a AS SELECT 1",
      "SELECT 2",
    ])
  })

  it("keeps semicolons inside quotes, dollar quotes and block comments", () => {
    const script = `SELECT 'a;b', "c;d";
SELECT $$x;y$$ /* e;f */;
SELECT $t$z;$t$`
    expect(splitSqlScript(script)).toEqual([
      `SELECT 'a;b', "c;d"`,
      "SELECT $$x;y$$ /* e;f */",
      "SELECT $t$z;$t$",
    ])
  })

  it("keeps doubled quotes and -- inside a string", () => {
    expect(
      splitSqlScript("SELECT 'it''s; -- not a comment'; SELECT 2")
    ).toEqual(["SELECT 'it''s; -- not a comment'", "SELECT 2"])
  })

  it("does not treat a parameter like $1 as a dollar quote", () => {
    expect(splitSqlScript("SELECT $1; SELECT 2;")).toEqual([
      "SELECT $1",
      "SELECT 2",
    ])
  })

  it("rejects an unterminated quote", () => {
    expect(() => splitSqlScript("SELECT 'open;")).toThrow(/inside a quote/)
  })
})

describe("fillPlaceholders", () => {
  it("replaces every known placeholder", () => {
    expect(
      fillPlaceholders(
        "read_csv('{{RAW_DIR}}/a.log'), read_csv('{{RAW_DIR}}/b.log')",
        { RAW_DIR: "/data/raw" }
      )
    ).toBe("read_csv('/data/raw/a.log'), read_csv('/data/raw/b.log')")
  })

  it("fails on an unknown placeholder instead of inserting nothing", () => {
    expect(() =>
      fillPlaceholders("{{MISSING}}", { RAW_DIR: "/data/raw" })
    ).toThrow(/MISSING/)
  })

  it("leaves SQL without placeholders unchanged", () => {
    expect(fillPlaceholders("SELECT $1, '{x}'", {})).toBe("SELECT $1, '{x}'")
  })
})
