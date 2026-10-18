import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as database from "@workspace/analytics/db"
import { FileReceiptStore, resultDigest } from "@workspace/analytics/receipts"
import type { Registry } from "@workspace/analytics/registry"
import { ROLE_SECTIONS, detectSections } from "@workspace/domain/answer"
import type { ToolResult } from "@workspace/domain/tool"
import { describe, expect, it, vi } from "vitest"

import { loadPlaybooks } from "../playbooks.ts"

import { baselineRegistryGuidance } from "./baseline.ts"
import { main } from "./cli.ts"
import * as investigation from "./investigation.ts"
import { modelView } from "./tools.ts"

/** Only database transport is stubbed: real describe_corpus, schemas and receipt storage. */
const ROWS: Record<string, Record<string, unknown>[]> = {
  load_manifest: [
    {
      data_version: "dv_baseline_test",
      source: "samples",
      loader_version: "1.0.0",
      parser_version: "1.0.0",
      pattern_rules_version: "1.0.0",
      ownership_version: "1.0.0",
      rules_version: "concept-3.4",
    },
  ],
  corpus_stats: [
    {
      dataset: "bgl",
      population_count: "1",
      lines_read: "1",
      events: "1",
      rejected: "0",
      first_event: "2005-06-03T22:42:50.000000Z",
      last_event: "2005-06-03T22:42:50.000000Z",
      error_events: "1",
      patterns: "1",
      single_event_patterns: "1",
      time_basis: "Unix seconds",
      label_source: "alert category",
      levels: [],
      components: [],
      labels: [],
      api_accesses: null,
      api_accesses_without_request_id: null,
      requests: null,
    },
  ],
  ownership: [],
  corpus_field_stats: [],
}

async function runDescribe(registry: Registry): Promise<ToolResult<unknown>> {
  const outcome = await registry.runTool(
    "describe_corpus",
    {},
    {
      client: "eval",
      signal: new AbortController().signal,
    }
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.result
}

// The CLI is the existing production dependency seam used by local samples.
// Run no model request: retain its fully assembled dependencies, then inspect
// preflight through the real registry and file receipt pipeline.
async function cliRegistry(variant: "baseline" | "playbook", dir: string) {
  let captured: investigation.InvestigationDeps | undefined
  const db = vi.spyOn(database, "createDatabase").mockReturnValue({
    timeoutMs: 10_000,
    dispose: async () => undefined,
    query: async (sql) => {
      const table = Object.keys(ROWS).find((name) =>
        sql.includes(`FROM ${name}`)
      )
      if (table === undefined) throw new Error("Unexpected fixture query")
      return { rows: ROWS[table] ?? [], durationMs: 1 }
    },
  })
  const run = vi
    .spyOn(investigation, "runInvestigation")
    .mockImplementationOnce((_input, deps) => {
      captured = deps
      throw new Error("dependency inspection only")
    })
  try {
    const code = await main(
      ["--variant", variant, "--role", "engineer", "Inspect KERNEL failures"],
      {
        ANTHROPIC_API_KEY: "test-only-key",
        SERENEDB_HOST: "127.0.0.1",
        SERENEDB_PORT: "5432",
        SERENEDB_USER: "test",
        SERENEDB_PASSWORD: "test-only-password",
        SERENEDB_DATABASE: "test",
        LOG_INSIGHTS_RECEIPTS_DIR: dir,
      },
      () => undefined,
      () => undefined
    )
    expect(code).toBe(1)
    if (captured === undefined)
      throw new Error("CLI did not assemble dependencies")
    return captured
  } finally {
    run.mockRestore()
    db.mockRestore()
  }
}

describe("LOG-52 baseline instruction channels", () => {
  it("assembles simple corpus guidance before the receipt is saved and keeps tool contracts equal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-receipts-"))
    try {
      const baseline = await cliRegistry("baseline", dir)
      const playbook = await cliRegistry("playbook", dir)
      expect(baseline.registry.catalog()).toEqual(playbook.registry.catalog())
      const simple = baselineRegistryGuidance(loadPlaybooks().version)
      const result = await runDescribe(baseline.registry)
      const saved = await new FileReceiptStore(dir).get(
        result.receipt.receipt_id
      )
      expect(saved?.result).toMatchObject({
        answer_guidance: { routing: simple.routing, roles: simple.roles },
        guidance_version: simple.version,
      })
      expect(result.data).toEqual(saved?.result)
      expect(result.receipt.result_digest).toBe(resultDigest(result.data))
      expect(saved?.result_digest).toBe(resultDigest(saved?.result))
      expect(modelView(result).data).toEqual(saved?.result)

      const baselineHints = JSON.stringify(modelView(result))
      const core = new Set<string>(Object.values(ROLE_SECTIONS.core).flat())
      for (const role of ["engineer", "team_lead", "manager"] as const) {
        const detected = detectSections(baselineHints, role).present
        expect(detected.filter((section) => core.has(section))).toEqual([])
      }
      expect(baselineHints).not.toMatch(/Required evidence|Coverage/)
      const full = await runDescribe(playbook.registry)
      expect(full.data).toMatchObject({
        answer_guidance: {
          routing: loadPlaybooks().guidance.routing,
          roles: loadPlaybooks().guidance.roles,
        },
      })
      expect(full.receipt.result_digest).not.toBe(result.receipt.result_digest)
      // Equal corpus input, tool and version keep the signature stable; the
      // instruction variant is part of the unmodified result and its digest.
      expect(full.receipt.signature).toBe(result.receipt.signature)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
