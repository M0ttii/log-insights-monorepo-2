import { EXTENSION_DATASETS } from "@workspace/domain/datasets"
import { describe, expect, it } from "vitest"

import { parseArgs, USAGE } from "./args.ts"

describe("parseArgs", () => {
  it("defaults to the base corpus without arguments", () => {
    expect(parseArgs([])).toEqual({ samples: false, extensions: [] })
  })

  it("reads --samples on its own and combined with --with", () => {
    expect(parseArgs(["--samples"])).toEqual({
      samples: true,
      extensions: [],
    })
    expect(parseArgs(["--samples", "--with", "hdfs"])).toEqual({
      samples: true,
      extensions: ["hdfs"],
    })
  })

  it("accepts --with as a separate value and as --with=", () => {
    expect(parseArgs(["--with", "linux"])).toEqual({
      samples: false,
      extensions: ["linux"],
    })
    expect(parseArgs(["--with=linux"])).toEqual({
      samples: false,
      extensions: ["linux"],
    })
  })

  it("splits a comma list and de-duplicates datasets", () => {
    expect(parseArgs(["--with", "hdfs,linux,hdfs"])).toEqual({
      samples: false,
      extensions: ["hdfs", "linux"],
    })
  })

  it("expands --with all to every extension dataset in catalog order", () => {
    expect(parseArgs(["--with", "all"])).toEqual({
      samples: false,
      extensions: [...EXTENSION_DATASETS],
    })
  })

  it("merges repeated --with flags without duplicates", () => {
    expect(
      parseArgs(["--with", "hdfs", "--with=zookeeper", "--with", "hdfs"])
    ).toEqual({ samples: false, extensions: ["hdfs", "zookeeper"] })
  })

  it("rejects an unknown dataset with the usage line", () => {
    const error = parseArgs(["--with", "mysql"])
    expect(typeof error).toBe("string")
    expect(error).toContain('Unknown dataset "mysql"')
    expect(error).toContain(USAGE)
  })

  it("rejects an unknown flag with the usage line", () => {
    const error = parseArgs(["--loud"])
    expect(error).toBe(`Unknown argument --loud; ${USAGE}`)
  })

  it("rejects a base dataset for --with (base is always loaded)", () => {
    expect(parseArgs(["--with", "bgl"])).toContain('Unknown dataset "bgl"')
    expect(parseArgs(["--with", "openstack"])).toContain(
      'Unknown dataset "openstack"'
    )
  })
})
