import { readdir } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { EXTENSION_DATASETS, type Dataset } from "@workspace/domain/datasets"

import { cleanupPlaceholders, loadSteps, readSql, SQL_FILES } from "./plan.ts"
import { buildSource, CORPUS, SAMPLES } from "./sources.ts"
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
        // A `--` comment may mention `{{EXTENSION_…}}` as prose; only the
        // executed statements must be free of any real {{NAME}} placeholder
        // (the ellipsis in the comment is not a valid placeholder name).
        for (const statement of splitSqlScript(filled))
          expect(statement).not.toMatch(/\{\{[A-Z_]+\}\}/)
        expect(splitSqlScript(filled).length).toBeGreaterThan(0)
      }
    }
  )

  it.each([
    { kind: "samples" as const, extensions: ["hdfs", "linux"] as Dataset[] },
    { kind: "corpus" as const, extensions: [...EXTENSION_DATASETS] },
  ])(
    "fills every placeholder of the $kind steps with extensions and leaves no placeholder in any statement",
    async ({ kind, extensions }) => {
      const source = buildSource(kind, extensions)
      const steps = [...loadSteps(source)]
      for (const step of steps) {
        const filled = fillPlaceholders(
          await readSql(step.file),
          step.placeholders(timings)
        )
        for (const statement of splitSqlScript(filled))
          expect(statement).not.toMatch(/\{\{[A-Z_]+\}\}/)
      }
      // Cleanup (99) runs after the checks with its own placeholders.
      const cleanup = fillPlaceholders(
        await readSql("99_cleanup.sql"),
        cleanupPlaceholders(source)
      )
      for (const statement of splitSqlScript(cleanup))
        expect(statement).not.toMatch(/\{\{[A-Z_]+\}\}/)
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

  it("names every loaded dataset and its parser in catalog order", () => {
    const source = buildSource("samples", ["hdfs", "linux"])
    const reads = loadSteps(source)
      .filter((step) => step.file === "05_read.sql")
      .map((step) => step.placeholders(timings)["DATASET"])
    // Base datasets stay first; extensions follow in catalog order.
    expect(reads).toEqual(["bgl", "openstack", "hdfs", "linux"])
  })

  it("passes the measured durations to the load report in seconds", () => {
    const report = loadSteps(SAMPLES).find(
      (step) => step.file === "15_load_report.sql"
    )
    const filled = report?.placeholders(timings)
    expect(filled?.["BGL_LOAD_S"]).toBe("1.234")
    expect(filled?.["OPENSTACK_LOAD_S"]).toBe("0.056")
    // Without extensions the per-extension pieces are empty.
    expect(filled?.["EXTENSION_REJECTS"]).toBe("")
    expect(filled?.["EXTENSION_DURATIONS"]).toBe("")
  })

  it("adds a duration case per loaded extension to the load report", () => {
    const source = buildSource("samples", ["hdfs", "linux"])
    const report = loadSteps(source).find(
      (step) => step.file === "15_load_report.sql"
    )
    const durations = report?.placeholders({
      ...timings,
      hdfs: 7,
      linux: 800,
    })["EXTENSION_DURATIONS"]
    expect(durations).toContain("WHEN 'hdfs' THEN 0.007")
    expect(durations).toContain("WHEN 'linux' THEN 0.800")
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
