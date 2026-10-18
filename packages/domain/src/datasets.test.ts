import { describe, expect, it } from "vitest"

import {
  BASE_DATASETS,
  DATASET_IDS,
  DATASETS,
  EXTENSION_DATASETS,
  EXTERNAL_DATASETS,
  EXTERNAL_ID_RANGE,
  REMOTE_SCAN_MAX_FILES,
  REMOTE_SCAN_MAX_SECONDS,
  SPECIFIC_COLUMNS,
  SPECIFIC_CONTEXT_SCOPES,
  SPECIFIC_DIMENSION_COLUMNS,
  SPECIFIC_FILTER_COLUMNS,
  datasetList,
  datasetSpecs,
  datasetsWithColumn,
  datasetsWithErrors,
  externalDatasetOfEventId,
  isExtension,
  isExternal,
  isTableDataset,
} from "./datasets.ts"

/**
 * The catalog is the one source for dataset IDs, columns, filters,
 * dimensions, scopes, sources and capabilities (U26). These checks guard
 * its internal consistency so a new entry cannot drift from the maps the
 * tools derive from it.
 */

describe("dataset catalog", () => {
  it("has a spec whose id matches its key for every dataset", () => {
    for (const id of DATASET_IDS) {
      expect(DATASETS[id]).toBeDefined()
      expect(DATASETS[id].id).toBe(id)
    }
  })

  it("keeps the base datasets first and partitions base, extensions and external datasets", () => {
    expect([
      ...BASE_DATASETS,
      ...EXTENSION_DATASETS,
      ...EXTERNAL_DATASETS,
    ]).toEqual([...DATASET_IDS])
    for (const id of DATASET_IDS) {
      expect(isExtension(id)).toBe(
        (EXTENSION_DATASETS as readonly string[]).includes(id)
      )
      expect(isExternal(id)).toBe(
        (EXTERNAL_DATASETS as readonly string[]).includes(id)
      )
      expect(isTableDataset(id)).toBe(!isExternal(id))
      expect(DATASETS[id].storage).toBe(
        id === "otel_replay"
          ? "otlp_replay"
          : isExternal(id)
            ? "remote_parquet"
            : "log_events"
      )
    }
  })

  it("gives every dataset a unique event id base, spaced by at least 10M", () => {
    const bases = DATASET_IDS.map((id) => DATASETS[id].eventIdBase)
    expect(new Set(bases).size).toBe(bases.length)
    const sorted = [...bases].toSorted((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++)
      expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        10_000_000
      )
  })

  it("maps every specific filter and dimension to a real specific column", () => {
    for (const column of Object.values(SPECIFIC_FILTER_COLUMNS))
      expect(SPECIFIC_COLUMNS).toContain(column)
    for (const column of Object.values(SPECIFIC_DIMENSION_COLUMNS))
      expect(SPECIFIC_COLUMNS).toContain(column)
    for (const column of Object.values(SPECIFIC_CONTEXT_SCOPES))
      expect(SPECIFIC_COLUMNS).toContain(column)
  })

  it("backs every specific filter/dimension/scope column with a dataset", () => {
    const used = new Set<string>([
      ...Object.values(SPECIFIC_FILTER_COLUMNS),
      ...Object.values(SPECIFIC_DIMENSION_COLUMNS),
      ...Object.values(SPECIFIC_CONTEXT_SCOPES),
    ])
    // The derived maps never resolve to an empty dataset list.
    const unbacked = [...used].filter(
      (column) =>
        datasetsWithColumn(column as (typeof SPECIFIC_COLUMNS)[number])
          .length === 0
    )
    expect(unbacked).toEqual([])
  })

  it("gives every table dataset both a corpus and a samples source with pinned files", () => {
    for (const id of DATASET_IDS) {
      const spec = DATASETS[id]
      if (spec.storage !== "log_events") continue
      for (const source of [spec.corpus, spec.samples]) {
        expect(source.logs.length).toBeGreaterThan(0)
        expect(source.expectedLines).toBeGreaterThan(0)
        const files = [
          ...source.archives,
          ...source.archives.flatMap((a) => a.entries),
          ...source.downloads,
        ]
        expect(files.length).toBeGreaterThan(0)
        for (const file of files) {
          expect(file.bytes).toBeGreaterThan(0)
          expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        }
      }
    }
  })

  it("names a context scope and a breadth unit only for columns it carries", () => {
    const missing: string[] = []
    for (const id of DATASET_IDS) {
      const spec = DATASETS[id]
      for (const scope of spec.contextScopes) {
        const column = SPECIFIC_CONTEXT_SCOPES[scope]
        if (spec.fields[column] === undefined)
          missing.push(`${id}.${scope} -> ${column}`)
      }
      if (
        spec.breadth !== null &&
        spec.fields[spec.breadth.column] === undefined
      )
        missing.push(`${id}.breadth -> ${spec.breadth.column}`)
    }
    expect(missing).toEqual([])
  })

  it("derives the error datasets from a non-null error definition", () => {
    const withErrors = datasetsWithErrors()
    for (const id of DATASET_IDS)
      expect(withErrors.includes(id)).toBe(
        DATASETS[id].errorDefinition !== null
      )
    // Linux has no level and no error marker (R-02), so it is excluded.
    expect(withErrors).not.toContain("linux")
    expect(withErrors).toContain("bgl")
  })

  it("lists datasets in catalog order for the given subset", () => {
    expect(datasetSpecs(["linux", "bgl"]).map((spec) => spec.id)).toEqual([
      "bgl",
      "linux",
    ])
    expect(datasetSpecs().map((spec) => spec.id)).toEqual([...DATASET_IDS])
  })

  it("routes event IDs of external datasets by their ID range", () => {
    expect(externalDatasetOfEventId(5)).toBeNull()
    expect(externalDatasetOfEventId(500_000_001)).toBeNull()
    const base = DATASETS.otel.eventIdBase
    expect(externalDatasetOfEventId(base)).toBe("otel")
    expect(externalDatasetOfEventId(base + EXTERNAL_ID_RANGE - 1)).toBe("otel")
    const replayBase = DATASETS.otel_replay.eventIdBase
    expect(externalDatasetOfEventId(replayBase)).toBe("otel_replay")
    expect(externalDatasetOfEventId(replayBase + EXTERNAL_ID_RANGE - 1)).toBe(
      "otel_replay"
    )
    expect(externalDatasetOfEventId(replayBase + EXTERNAL_ID_RANGE)).toBeNull()
    // The largest otel ID stays below the external range and is a safe integer.
    const { files, eventIdFileStride } = DATASETS.otel.remote
    const largest = base + files.length * eventIdFileStride
    expect(largest).toBeLessThan(base + EXTERNAL_ID_RANGE)
    expect(Number.isSafeInteger(largest)).toBe(true)
    // A file holds at most 1e9 rows (LOG-35 probe), far below the stride.
    expect(eventIdFileStride).toBeGreaterThan(1_000_000_000)
  })

  it("allowlists exactly the 50 text_bench files of the brief", () => {
    const { files, reference, samples } = DATASETS.otel.remote
    expect(files).toHaveLength(50)
    files.forEach((file, index) => {
      const name = `part_${String(index).padStart(3, "0")}.parquet`
      expect(file.index).toBe(index)
      expect(file.url).toBe(
        `https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/${name}`
      )
      expect(file.s3).toBe(`s3://public-pme/text_bench/${name}`)
    })
    expect(files.some((file) => file.url.endsWith("part_050.parquet"))).toBe(
      false
    )
    // The reference glob names exactly the two files around one boundary.
    expect(reference.files).toEqual([0, 1])
    expect(reference.glob).toBe(
      "s3://public-pme/text_bench/part_00[0-1].parquet"
    )
    expect(samples.files.map((file) => file.index)).toEqual(reference.files)
    for (const file of samples.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.path).toMatch(/^otel\/part_00[01]\.parquet$/)
    }
    expect(REMOTE_SCAN_MAX_SECONDS).toBe(60)
    expect(REMOTE_SCAN_MAX_FILES).toBe(2)
  })

  it("renders a one-line description of every dataset", () => {
    const list = datasetList()
    for (const id of DATASET_IDS) expect(list).toContain(`${id} (`)
  })
})
