import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { InvestigationInput } from "@workspace/agent/ai-sdk"
import { describe, expect, it, vi } from "vitest"

// This exercises the real round/export/report lifecycle. The provider and DB
// boundary are replaced before importing the runner; no paid model can run.
const state = vi.hoisted(() => ({
  stop: () => {},
  calls: 0,
  disposed: 0,
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
  createDatabase: () => ({
    query: () => {
      throw new Error("Offline fixture must never query a DB")
    },
    timeoutMs: 10_000,
    dispose: async () => {
      state.disposed += 1
    },
  }),
}))
vi.mock("@workspace/agent/ai-sdk", async (original) => {
  const actual = await original<typeof import("@workspace/agent/ai-sdk")>()
  return {
    ...actual,
    resolveModel: () => ({
      model: null,
      modelId: "claude-opus-5-5",
      effort: "high",
      providerOptions: { anthropic: {} },
    }),
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
      expect(state.calls).toBe(1)
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
})
