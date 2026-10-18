import { readdir } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import {
  EXTENSION_DATASETS,
  type TableDataset,
} from "@workspace/domain/datasets"

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
    {
      kind: "samples" as const,
      extensions: ["hdfs", "linux"] as TableDataset[],
    },
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

  it.each(["corpus", "samples"] as const)(
    "fills the otel steps of the %s source from the load facts and reads the files through the catalog",
    async (kind) => {
      const source = buildSource(kind, [], ["otel"])
      const [load] = source.external
      if (load === undefined) throw new Error("no otel load")
      const facts = {
        otelPins: load.files.map((file) => ({
          file_index: file.file_index,
          location: file.location,
          bytes: 100,
          etag: kind === "corpus" ? '"e"' : null,
          last_modified: kind === "corpus" ? "2026-03-15T17:44:11.000Z" : null,
          sha256: kind === "corpus" ? null : "0".repeat(64),
        })),
        otelRanges: load.files.map((file, index) => ({
          file_index: file.file_index,
          from: `2025-09-23T00:${String(index).padStart(2, "0")}:00.000000000Z`,
          to:
            index === load.files.length - 1
              ? null
              : `2025-09-23T00:${String(index + 1).padStart(2, "0")}:00.000000000Z`,
        })),
        otelIndex: { builtAt: "2026-10-18T16:50:24.548Z", ms: 1234.5 },
      }
      const steps = loadSteps(source)
      const files = steps.map((step) => step.file)
      // The otel steps sit between the log_events index and the checks.
      expect(files.slice(files.indexOf("50_index.sql"))).toEqual([
        "50_index.sql",
        "60_otel_sources.sql",
        "61_otel_reference.sql",
        "62_otel_stats.sql",
        "90_checks.sql",
      ])
      for (const step of steps) {
        const filled = fillPlaceholders(
          await readSql(step.file),
          step.placeholders(timings, facts)
        )
        for (const statement of splitSqlScript(filled))
          expect(statement).not.toMatch(/\{\{[A-Z_]+\}\}/)
      }
      const reference = steps
        .find((step) => step.file === "61_otel_reference.sql")
        ?.placeholders(timings, facts)
      // Exactly the reference files, each with its half-open range.
      expect(reference?.["DEDUPE"]).toBe(
        `(filename = '${load.files[0]?.globName}' AND "Timestamp" >= '2025-09-23T00:00:00.000000000Z'::TIMESTAMPTZ_NS AND "Timestamp" < '2025-09-23T00:01:00.000000000Z'::TIMESTAMPTZ_NS) OR ` +
          `(filename = '${load.files[1]?.globName}' AND "Timestamp" >= '2025-09-23T00:01:00.000000000Z'::TIMESTAMPTZ_NS${kind === "samples" ? "" : ` AND "Timestamp" < '2025-09-23T00:02:00.000000000Z'::TIMESTAMPTZ_NS`})`
      )
      expect(reference?.["GLOB"]).toBe(
        kind === "corpus"
          ? "s3://public-pme/text_bench/part_00[0-1].parquet"
          : "/data/raw/otel/part_00[0-1].parquet"
      )
      const sources = steps
        .find((step) => step.file === "60_otel_sources.sql")
        ?.placeholders(timings, facts)
      expect(sources?.["LOCATIONS"]).toContain(
        kind === "corpus"
          ? "'https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_049.parquet'"
          : "'/data/raw/otel/part_001.parquet'"
      )
      // Pins must exist before the first SQL step reads them.
      expect(() =>
        steps
          .find((step) => step.file === "60_otel_sources.sql")
          ?.placeholders(timings, {})
      ).toThrow("otel pins")
    }
  )

  it("keeps otel out of log_events and puts a samples load with it into its own database", () => {
    const corpus = buildSource("corpus", [], ["otel"])
    expect(corpus.database).toBeNull()
    expect(corpus.datasets.map((entry) => entry.dataset)).toEqual([
      "bgl",
      "openstack",
    ])
    expect(corpus.external.map((entry) => [entry.dataset, entry.kind])).toEqual(
      [["otel", "remote"]]
    )
    expect(corpus.external[0]?.files).toHaveLength(50)
    const samples = buildSource("samples", [], ["otel"])
    expect(samples.database).toBe("log_insights_samples_otel")
    expect(samples.external[0]?.kind).toBe("fixture")
    expect(samples.external[0]?.files.map((file) => file.location)).toEqual([
      "/data/raw/otel/part_000.parquet",
      "/data/raw/otel/part_001.parquet",
    ])
    // A load without otel has no otel step (01_schema.sql drops its objects).
    expect(loadSteps(SAMPLES).map((step) => step.file)).not.toContain(
      "60_otel_sources.sql"
    )
  })

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
