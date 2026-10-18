import { describe, expect, it } from "vitest"

import { CliUsageError, parseCliArgs, runCli } from "./cli.ts"

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
