import { describe, expect, it, vi } from "vitest"

import { loadPlaybooks } from "../playbooks.ts"

import { CliUsageError, main, parseCliArgs, runCli } from "./cli.ts"
import * as investigation from "./investigation.ts"

describe("parseCliArgs", () => {
  it("parses role, variant, effort and the positional question", () => {
    const args = parseCliArgs([
      "--role",
      "engineer",
      "--variant",
      "baseline",
      "--effort",
      "max",
      "Why did errors spike?",
    ])
    expect(args).toEqual({
      role: "engineer",
      variant: "baseline",
      effort: "max",
      question: "Why did errors spike?",
    })
  })

  it("defaults role=auto, variant=playbook, effort=high", () => {
    const args = parseCliArgs(["a question"])
    expect(args).toEqual({
      role: "auto",
      variant: "playbook",
      effort: "high",
      question: "a question",
    })
  })

  it("rejects an unknown role, variant or effort", () => {
    expect(() => parseCliArgs(["--role", "ceo", "q"])).toThrow(CliUsageError)
    expect(() => parseCliArgs(["--variant", "fancy", "q"])).toThrow(
      CliUsageError
    )
    expect(() => parseCliArgs(["--effort", "turbo", "q"])).toThrow(
      CliUsageError
    )
  })

  it("requires a question", () => {
    expect(() => parseCliArgs(["--role", "engineer"])).toThrow(CliUsageError)
  })
})

function sink() {
  const lines: string[] = []
  return { lines, write: (line: string) => lines.push(line) }
}

describe("runCli", () => {
  it("exits non-zero with a clear message when ANTHROPIC_API_KEY is missing", () => {
    const err = sink()
    const out = sink()
    const code = runCli(["engineer question"], {}, out.write, err.write)
    expect(code).toBe(1)
    expect(err.lines.join("\n")).toContain("ANTHROPIC_API_KEY is not set")
    expect(out.lines).toEqual([])
  })

  it("exits 2 on a usage error, printing usage to stderr", () => {
    const err = sink()
    const out = sink()
    const code = runCli(
      ["--role", "ceo", "q"],
      { ANTHROPIC_API_KEY: "sk" },
      out.write,
      err.write
    )
    expect(code).toBe(2)
    expect(err.lines.join("\n")).toContain("Usage:")
    expect(out.lines).toEqual([])
  })

  it("accepts a valid invocation with a key present", () => {
    const err = sink()
    const out = sink()
    const code = runCli(
      ["engineer question"],
      { ANTHROPIC_API_KEY: "sk" },
      out.write,
      err.write
    )
    expect(code).toBe(0)
  })
})

describe("CLI investigation dependencies", () => {
  it("passes the coverage parsed from the playbooks to the runner", async () => {
    const run = vi
      .spyOn(investigation, "runInvestigation")
      .mockImplementationOnce(() => {
        throw new Error("stop after dependency handoff")
      })
    const err = sink()
    try {
      const code = await main(
        ["--role", "manager", "Which investigation should come first?"],
        {
          ANTHROPIC_API_KEY: "test-only-key",
          SERENEDB_HOST: "127.0.0.1",
          SERENEDB_PORT: "5432",
          SERENEDB_USER: "test",
          SERENEDB_PASSWORD: "test-only-password",
          SERENEDB_DATABASE: "test",
        },
        sink().write,
        err.write
      )
      expect(code).toBe(1)
      expect(err.lines).toContain("stop after dependency handoff")
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0]?.[1].playbooks.coverage).toEqual(
        loadPlaybooks().coverage
      )
    } finally {
      run.mockRestore()
    }
  })
})
