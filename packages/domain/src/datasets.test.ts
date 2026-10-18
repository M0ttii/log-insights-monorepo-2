import { describe, expect, it } from "vitest"

import {
  BASE_DATASETS,
  DATASET_IDS,
  DATASETS,
  EXTENSION_DATASETS,
  SPECIFIC_COLUMNS,
  SPECIFIC_CONTEXT_SCOPES,
  SPECIFIC_DIMENSION_COLUMNS,
  SPECIFIC_FILTER_COLUMNS,
  datasetList,
  datasetSpecs,
  datasetsWithColumn,
  datasetsWithErrors,
  isExtension,
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

  it("keeps the base datasets first and partitions base and extensions", () => {
    expect([...BASE_DATASETS, ...EXTENSION_DATASETS]).toEqual([...DATASET_IDS])
    for (const id of DATASET_IDS)
      expect(isExtension(id)).toBe(
        (EXTENSION_DATASETS as readonly string[]).includes(id)
      )
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

  it("gives every dataset both a corpus and a samples source with pinned files", () => {
    for (const id of DATASET_IDS) {
      const spec = DATASETS[id]
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

  it("renders a one-line description of every dataset", () => {
    const list = datasetList()
    for (const id of DATASET_IDS) expect(list).toContain(`${id} (`)
  })
})
