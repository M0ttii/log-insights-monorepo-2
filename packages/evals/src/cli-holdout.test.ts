import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { findWorkspaceRoot } from "@workspace/analytics/config"

// Synthetic command-boundary controls; no private set, DB or provider is opened.
const boundary = vi.hoisted(() => ({
  status: vi.fn<
    () => Promise<{ acceptance: "not_demonstrated"; completion: "unconfirmed" }>
  >(async () => ({
    acceptance: "not_demonstrated",
    completion: "unconfirmed",
  })),
  report: vi.fn<
    () => Promise<{
      split: "holdout_first"
      round_id: string
      acceptance: string
    }>
  >(async () => ({
    split: "holdout_first",
    round_id: "synthetic-first",
    acceptance: "not_demonstrated",
  })),
  register: vi.fn<() => Promise<{ status: string }>>(async () => ({
    status: "synthetic_preparation",
  })),
  freeze: vi.fn<() => Promise<{ status: string }>>(async () => ({
    status: "synthetic_freeze",
  })),
  plan: vi.fn<() => Promise<{ round_id: string; attempts: [] }>>(async () => ({
    round_id: "synthetic-first",
    attempts: [],
  })),
  execute: vi.fn<() => Promise<void>>(async () => undefined),
  release: vi.fn<() => Promise<{ status: string }>>(async () => ({
    status: "synthetic_release",
  })),
}))
vi.mock("./holdout.ts", () => ({
  registerHoldout: boundary.register,
  freezeHoldout: boundary.freeze,
  releaseHoldout: boundary.release,
}))

vi.mock("./holdout-executor.ts", () => ({
  prepareHoldoutRound: boundary.plan,
  executeHoldoutRound: boundary.execute,
}))

vi.mock("./development.ts", async (original) => ({
  ...(await original<typeof import("./development.ts")>()),
  recomputeDevelopmentReport: boundary.report,
}))

vi.mock("./report.ts", async (original) => ({
  ...(await original<typeof import("./report.ts")>()),
  readHoldoutStatus: boundary.status,
}))

import { main } from "./cli.ts"
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("holdout CLI boundaries", () => {
  it("offers status-only inspection for an unconfirmed first round without opening review or execution", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true)
    const root = findWorkspaceRoot()
    await main([
      "holdout-status",
      "packages/evals/results/synthetic-interrupted",
    ])
    expect(boundary.status).toHaveBeenCalledWith(
      resolve(root, "packages/evals/results/synthetic-interrupted")
    )
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({ acceptance: "not_demonstrated", completion: "unconfirmed" }, null, 2)}\n`
    )
    expect(boundary.report).not.toHaveBeenCalled()
    expect(boundary.execute).not.toHaveBeenCalled()
    await expect(
      main([
        "holdout-status",
        "packages/evals/results/synthetic-interrupted",
        "--resume",
      ])
    ).rejects.toThrow(/Unexpected holdout-status arguments/)
    expect(boundary.status).toHaveBeenCalledTimes(1)
  })

  it("replays the saved first-holdout report from its separate directory and detects a changed original", async () => {
    const dir = await mkdtemp(join(tmpdir(), "log55-cli-replay-"))
    directories.push(dir)
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true)
    await mkdir(join(dir, "review-input"))
    await mkdir(join(dir, "holdout-reports"))
    await writeFile(
      join(dir, "review-input/synthetic-v1.json"),
      JSON.stringify({ synthetic: true })
    )
    const report = await boundary.report()
    const original = join(dir, "holdout-reports/synthetic-v1.json")
    await writeFile(original, JSON.stringify(report))
    await main(["holdout-report", dir, "synthetic-v1"])
    expect(boundary.report).toHaveBeenCalledWith(dir, "synthetic-v1", {
      synthetic: true,
    })
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(report, null, 2)}\n`)
    await writeFile(
      original,
      JSON.stringify({ ...report, acceptance: "changed-original" })
    )
    await expect(main(["holdout-report", dir, "synthetic-v1"])).rejects.toThrow(
      /report changed/
    )
    await expect(
      main(["development-report", dir, "synthetic-v1"])
    ).rejects.toThrow(/report command for the saved/)
  })

  it("routes an explicitly released first round separately from development and release", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const root = findWorkspaceRoot()
    await main([
      "holdout-plan",
      "packages/evals/results/synthetic-first",
      ".data/preparation",
      ".data/freeze",
    ])
    expect(boundary.plan).toHaveBeenCalledWith(
      resolve(root, ".data/preparation"),
      resolve(root, ".data/freeze"),
      resolve(root, "packages/evals/results/synthetic-first")
    )
    expect(boundary.execute).not.toHaveBeenCalled()
    expect(boundary.release).not.toHaveBeenCalled()
    await main(["holdout-execute", "packages/evals/results/synthetic-first"])
    expect(boundary.execute).toHaveBeenCalledWith(
      resolve(root, "packages/evals/results/synthetic-first"),
      expect.any(AbortSignal)
    )
  })

  it("routes public registration separately from private release", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true)
    const root = findWorkspaceRoot()
    await main([
      "holdout-register",
      ".data/preparation",
      "/private/public-metadata.json",
    ])
    expect(boundary.register).toHaveBeenCalledWith(
      "/private/public-metadata.json",
      resolve(root, ".data/preparation")
    )
    expect(boundary.freeze).not.toHaveBeenCalled()
    expect(boundary.release).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({ status: "synthetic_preparation" }, null, 2)}\n`
    )
  })

  it("routes freeze to the explicit saved development review", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const root = findWorkspaceRoot()
    await main([
      "holdout-freeze",
      ".data/freeze",
      ".data/preparation",
      ".data/development",
      "review-1",
    ])
    expect(boundary.freeze).toHaveBeenCalledWith(
      resolve(root, ".data/preparation"),
      resolve(root, ".data/development"),
      "review-1",
      resolve(root, ".data/freeze")
    )
    expect(boundary.release).not.toHaveBeenCalled()
  })

  it("fixes the public release destination and does not expose another output override", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const root = findWorkspaceRoot()
    await main([
      "holdout-release",
      ".data/preparation",
      ".data/freeze",
      "/private/synthetic-vault",
    ])
    expect(boundary.release).toHaveBeenCalledWith(
      resolve(root, ".data/preparation"),
      resolve(root, ".data/freeze"),
      "/private/synthetic-vault",
      resolve(root, "packages/evals/questions")
    )
    await expect(
      main([
        "holdout-release",
        ".data/preparation",
        ".data/freeze",
        "/private/synthetic-vault",
        "--bypass",
      ])
    ).rejects.toThrow(/requires freeze and private vault/)
    expect(boundary.release).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["holdout-register", ".data/preparation"],
    ["holdout-freeze", ".data/freeze", ".data/preparation"],
    ["holdout-release", ".data/preparation", ".data/freeze"],
  ])("rejects incomplete command %j", async (...args) => {
    await expect(main(args)).rejects.toThrow(/requires/)
    expect(boundary.register).not.toHaveBeenCalled()
    expect(boundary.freeze).not.toHaveBeenCalled()
    expect(boundary.release).not.toHaveBeenCalled()
  })
})
