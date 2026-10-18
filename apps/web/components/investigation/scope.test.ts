import { describe, expect, it } from "vitest"
import { changeDataset, readScope, scopeError } from "./scope"

describe("composer scope", () => {
  it("preserves the complete example scope, including filters", () => {
    expect(
      readScope({ dataset: "bgl", components: ["KERNEL"], only_errors: true })
    ).toEqual({ dataset: "bgl", components: ["KERNEL"], only_errors: true })
    expect(readScope({ dataset: "invented" })).toEqual({})
    expect(
      readScope({
        dataset: "bgl",
        team: "Workload Runtime",
        component: "KERNEL",
      })
    ).toEqual({
      dataset: "bgl",
      teams: ["Workload Runtime"],
      components: ["KERNEL"],
    })
  })
  it("clears the previous time axis and filters when changing datasets", () => {
    expect(
      changeDataset(
        { dataset: "bgl", from: "2005-06-01T00:00:00Z", node: "R02" },
        "openstack"
      )
    ).toEqual({ dataset: "openstack" })
    expect(changeDataset({ dataset: "bgl", node: "R02" }, "bgl")).toEqual({
      dataset: "bgl",
      node: "R02",
    })
  })
  it("uses the canonical range and dataset validation", () => {
    expect(
      scopeError({ from: "2005-06-01T00:00:00Z", to: "2005-06-01T00:00:00Z" })
    ).toMatch(/later/)
    expect(scopeError({ dataset: "openstack", node: "R02" })).toMatch(/bgl/)
    expect(scopeError({ from: "bad" })).toBeTruthy()
    expect(scopeError({ dataset: "bgl" })).toBeNull()
  })
})
