import { resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { findWorkspaceRoot } from "@workspace/analytics/config"

// Synthetic command-boundary controls; no private set, DB or provider is opened.
const boundary = vi.hoisted(() => ({
  register: vi.fn<() => Promise<{ status: string }>>(async () => ({
    status: "synthetic_preparation",
  })),
  freeze: vi.fn<() => Promise<{ status: string }>>(async () => ({
    status: "synthetic_freeze",
  })),
  release: vi.fn<() => Promise<{ status: string }>>(async () => ({
    status: "synthetic_release",
  })),
}))
vi.mock("./holdout.ts", () => ({
  registerHoldout: boundary.register,
  freezeHoldout: boundary.freeze,
  releaseHoldout: boundary.release,
}))

import { main } from "./cli.ts"

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("holdout CLI boundaries", () => {
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
