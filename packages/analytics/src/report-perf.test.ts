import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { runPerformanceReport } from "./performance.ts"
import {
  parsePerformanceArgs,
  performanceMarkdown,
  writePerformanceReport,
} from "./report-perf.ts"

describe("performance report CLI", () => {
  it("rejects unknown flags and positional arguments", () => {
    expect(() => parsePerformanceArgs(["--made-up"])).toThrow(/Unknown option/)
    expect(() => parsePerformanceArgs(["unexpected"])).toThrow(
      /Unexpected argument/
    )
    expect(parsePerformanceArgs(["--help"]).help).toBe(true)
  })

  it("keeps absent measurements empty and refuses output replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "log56-report-"))
    try {
      const report = await runPerformanceReport(
        {
          query() {
            throw new Error("Empty sources must not query")
          },
        },
        { receipts_dir: join(directory, "missing") }
      )
      const output = join(directory, "snapshot")
      await writePerformanceReport(output, report)
      const before = await readFile(join(output, "report.json"), "utf8")
      expect(JSON.parse(before)).toEqual(report)
      expect(await readFile(join(output, "report.md"), "utf8")).toBe(
        performanceMarkdown(report)
      )
      expect(performanceMarkdown(report)).toContain("n: not measured")
      expect(performanceMarkdown(report)).not.toContain("| 0 |")
      await expect(writePerformanceReport(output, report)).rejects.toThrow(
        /EEXIST/
      )
      expect(await readFile(join(output, "report.json"), "utf8")).toBe(before)
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
