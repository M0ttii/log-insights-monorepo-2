import { describe, expect, it } from "vitest"

import { datasetNotLoaded, spanEnd } from "./corpus.ts"

/**
 * Pure helpers of corpus.ts. The DB-backed readers (loadedDatasets,
 * requireDataSpan, getDataSpan) are covered against SereneDB in the
 * integration suite and through the tool tests.
 */

describe("datasetNotLoaded", () => {
  it("names the loaded datasets and how to load the missing one (U26)", () => {
    const error = datasetNotLoaded("hdfs", ["bgl", "openstack"])
    expect(error.code).toBe("invalid_input")
    if (error.code !== "invalid_input")
      throw new Error("expected invalid_input")
    expect(error.issues).toEqual([
      {
        path: "dataset",
        message: "Dataset hdfs is not loaded; loaded: bgl, openstack.",
      },
    ])
    expect(error.hint).toBe(
      "Use one of bgl, openstack, or ask the user to load it with `pnpm data:setup --with hdfs` and restart the client."
    )
  })
})

describe("spanEnd", () => {
  it("returns one microsecond after the last event (windows are [from, to))", () => {
    expect(
      spanEnd({
        first: "2005-06-03T22:42:50.675872Z",
        last: "2006-01-03T15:13:09.127918Z",
      })
    ).toBe("2006-01-03T15:13:09.127919Z")
  })
})
