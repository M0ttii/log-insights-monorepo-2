import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { LOG_TEXT_ANALYZER } from "./analyzer.ts"

/** Collapses whitespace so line breaks in SQL do not matter. */
const flat = (sql: string) => sql.replaceAll(/\s+/g, " ")

const read = (relative: string) =>
  readFile(new URL(relative, import.meta.url), "utf8")

describe("LOG_TEXT_ANALYZER", () => {
  it.each([
    "../sql/50_index.sql",
    "../gate/sql/20_bgl_index.sql",
    "../../analytics/tests/integration/fixtures.ts",
  ])("is the analyzer of the log dictionary in %s", async (file) => {
    const sql = flat(await read(file))
    expect(sql).toContain(
      `AS ${LOG_TEXT_ANALYZER} WITH (frequency, position, norm)`
    )
    // The 26.09.1.3 option-list syntax is a syntax error on 26.10.1.
    expect(sql).not.toMatch(/\(\s*template\s*=/)
  })

  it("has no stemming or stop-word stage", () => {
    expect(LOG_TEXT_ANALYZER).not.toMatch(/stem_words|remove_stopwords/)
  })
})
