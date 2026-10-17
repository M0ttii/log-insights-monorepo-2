import { readdir } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { loadSteps, readSql, SQL_FILES } from "./plan.ts"
import { CORPUS, SAMPLES } from "./sources.ts"
import { fillPlaceholders, splitSqlScript } from "./sql-script.ts"

const timings = { bgl: 1234, openstack: 56, shared: 0 }

describe("SQL plan", () => {
  it("lists every file in sql/ exactly once, in name order", async () => {
    const files = (await readdir(new URL("../sql/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .toSorted()
    expect([...SQL_FILES]).toEqual(files)
  })

  it.each([CORPUS, SAMPLES])(
    "fills every placeholder of the $id steps",
    async (source) => {
      for (const step of loadSteps(source)) {
        const filled = fillPlaceholders(
          await readSql(step.file),
          step.placeholders(timings)
        )
        expect(filled).not.toMatch(/\{\{/)
        expect(splitSqlScript(filled).length).toBeGreaterThan(0)
      }
    }
  )

  it("reads each dataset with its files in the declared order", () => {
    const reads = loadSteps(CORPUS)
      .filter((step) => step.file === "05_read.sql")
      .map((step) => step.placeholders(timings))
    expect(reads).toEqual([
      { DATASET: "bgl", FILES: "['/data/raw/BGL.log']" },
      {
        DATASET: "openstack",
        FILES:
          "['/data/raw/openstack/openstack_abnormal.log', " +
          "'/data/raw/openstack/openstack_normal1.log', " +
          "'/data/raw/openstack/openstack_normal2.log']",
      },
    ])
  })

  it("passes the measured durations to the load report in seconds", () => {
    const report = loadSteps(SAMPLES).find(
      (step) => step.file === "15_load_report.sql"
    )
    expect(report?.placeholders(timings)).toEqual({
      BGL_LOAD_S: "1.234",
      OPENSTACK_LOAD_S: "0.056",
    })
  })

  it("marks sources without anomaly labels", () => {
    const openstack = loadSteps(SAMPLES).find(
      (step) => step.file === "11_openstack.sql"
    )
    expect(openstack?.placeholders(timings)["OPENSTACK_LABELS_AVAILABLE"]).toBe(
      "false"
    )
    const corpus = loadSteps(CORPUS).find(
      (step) => step.file === "11_openstack.sql"
    )
    expect(corpus?.placeholders(timings)["OPENSTACK_LABELS_AVAILABLE"]).toBe(
      "true"
    )
  })

  it("keeps the manifest a single parameterised statement", async () => {
    expect(splitSqlScript(await readSql("95_manifest.sql"))).toHaveLength(1)
  })
})
