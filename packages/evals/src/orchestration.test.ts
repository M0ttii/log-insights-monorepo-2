import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { InvestigationInput } from "@workspace/agent/ai-sdk"
import { canonicalJson } from "@workspace/domain/receipt"
import { beforeEach, describe, expect, it, vi } from "vitest"

// This exercises the real round/export/report lifecycle. The provider and DB
// boundary are replaced before importing the runner; no paid model can run.
const state = vi.hoisted(() => ({
  stop: () => {},
  calls: 0,
  resolvedModels: 0,
  databases: 0,
  disposed: 0,
  observedDirectory: "",
  runtime: {
    observed_at: "2026-10-18T00:00:00.000Z",
    configured_image: "offline-control",
    running_image_id: `sha256:${"0".repeat(64)}`,
    published_port: 1,
    corpus_receipt_id: "r_00000000",
    corpus_receipt_sha256: "0".repeat(64),
    data_version: "dv_fixtureOnly",
    source: "corpus",
    datasets: ["bgl", "openstack"],
    lockfile_sha256: "0".repeat(64),
  },
}))
vi.mock("@workspace/analytics/config", async (original) => {
  const actual = await original<typeof import("@workspace/analytics/config")>()
  return {
    ...actual,
    loadConfig: () => ({
      connection: {
        host: "127.0.0.1",
        port: 1,
        user: "fixture",
        password: "fixture",
        database: "fixture",
      },
      receiptsDir: "unused",
      workspaceTools: false,
    }),
  }
})
vi.mock("@workspace/analytics/db", () => ({
  createDatabase: () => {
    state.databases += 1
    return {
      query: () => {
        throw new Error("Offline fixture must never query a DB")
      },
      timeoutMs: 10_000,
      dispose: async () => {
        state.disposed += 1
      },
    }
  },
}))
// Only the new read-only external provenance boundary is replaced. The full
// round still runs and asserts cancellation, export and exactly one disposal.
vi.mock("./holdout-runtime.ts", async (original) => ({
  ...(await original<typeof import("./holdout-runtime.ts")>()),
  observeEvalRuntime: async (receiptsDirectory: string) => {
    state.observedDirectory = receiptsDirectory
    // The real observer stores its receipt before returning the observation.
    // Preserve that boundary even when execution rejects the observed corpus.
    await mkdir(receiptsDirectory, { recursive: true })
    await writeFile(
      join(receiptsDirectory, "r_00000000.json"),
      JSON.stringify({ data_version: state.runtime.data_version }),
      { flag: "wx" }
    )
    return structuredClone(state.runtime)
  },
}))
vi.mock("@workspace/agent/ai-sdk", async (original) => {
  const actual = await original<typeof import("@workspace/agent/ai-sdk")>()
  return {
    ...actual,
    resolveModel: () => {
      state.resolvedModels += 1
      return {
        model: null,
        modelId: "claude-opus-5-5",
        effort: "high",
        providerOptions: { anthropic: {} },
      }
    },
    runInvestigation: (input: InvestigationInput) => {
      state.calls += 1
      state.stop()
      const record = actual.runRecordSchema.parse({
        run_id: "run_000000ab",
        started_at: "2026-10-18T00:00:00.000Z",
        finished_at: "2026-10-18T00:00:00.001Z",
        duration_ms: 1,
        status: "stopped",
        variant: input.variant,
        role: { requested: input.role, effective: "auto" },
        question: input.question,
        scope: input.scope ?? null,
        model_id: "claude-opus-5-5",
        effort: "high",
        guidance_version: "offline-cancellation-control",
        contract_version: "fixture",
        data_version: "dv_fixtureOnly",
        instruction_texts: [],
        phases: [],
        coverage_requests: [],
        gate_findings: [],
        usage: {
          input: null,
          output: null,
          cache_read: null,
          cache_write: null,
        },
        final_text: null,
        check_claims: [],
        error_kind: null,
        model_calls: 0,
      })
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        done: Promise.resolve(record),
      }
    },
  }
})
import { runLiveRound } from "./runner.ts"

describe("round cancellation with offline dependencies", () => {
  beforeEach(() => {
    state.stop = () => {}
    state.calls = 0
    state.resolvedModels = 0
    state.databases = 0
    state.disposed = 0
    state.observedDirectory = ""
    state.runtime.data_version = "dv_fixtureOnly"
  })

  it("exports the interrupted attempt, preserves planned missing attempts and disposes the DB", async () => {
    const root = await mkdtemp(join(tmpdir(), "log52-cancellation-"))
    const dir = join(root, "round")
    const controller = new AbortController()
    state.stop = () => controller.abort()
    try {
      await runLiveRound(dir, "dv_fixtureOnly", controller.signal)
      const manifest = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8")
      )
      const report = JSON.parse(
        await readFile(join(dir, "reports/1.0.0.json"), "utf8")
      )
      const runtime = JSON.parse(
        await readFile(join(dir, "runtime.json"), "utf8")
      )
      const execution = JSON.parse(
        await readFile(join(dir, "execution.json"), "utf8")
      )
      expect(runtime).toEqual(state.runtime)
      expect(execution).toEqual({
        started_at: expect.any(String),
        manifest_sha256: createHash("sha256")
          .update(canonicalJson(manifest))
          .digest("hex"),
        runtime_sha256: createHash("sha256")
          .update(canonicalJson(runtime))
          .digest("hex"),
      })
      expect(state.observedDirectory).toBe(join(dir, "runtime-receipts"))
      expect(state.resolvedModels).toBe(1)
      expect(state.calls).toBe(1)
      expect(state.databases).toBe(1)
      expect(state.disposed).toBe(1)
      expect(manifest.attempts).toHaveLength(58)
      expect(report.attempts[0].status).toBe("aborted")
      expect(
        report.attempts.filter(
          (attempt: { status: string }) => attempt.status === "missing"
        )
      ).toHaveLength(57)
      expect(report.measurement_complete).toBe(false)
      expect(report.acceptance).not.toBe("pending_external_acceptance")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an observed corpus mismatch before opening an execution or calling the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "log54-corpus-mismatch-"))
    const dir = join(root, "round")
    state.runtime.data_version = "dv_otherCorpus"
    try {
      await expect(
        runLiveRound(dir, "dv_fixtureOnly", new AbortController().signal)
      ).rejects.toThrow(
        "Observed corpus differs from the prepared data version"
      )
      expect(state.observedDirectory).toBe(join(dir, "runtime-receipts"))
      expect(state.resolvedModels).toBe(0)
      expect(state.calls).toBe(0)
      expect(state.databases).toBe(0)
      expect(state.disposed).toBe(0)
      expect((await readdir(dir)).toSorted()).toEqual([
        "manifest.json",
        "questions.json",
        "runtime-receipts",
      ])
      expect(
        JSON.parse(
          await readFile(join(dir, "runtime-receipts/r_00000000.json"), "utf8")
        )
      ).toEqual({ data_version: "dv_otherCorpus" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
