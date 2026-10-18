import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  FileRunStore,
  newRunId,
  resolveRunsDir,
  RUN_ID_PATTERN,
  runRecordSchema,
  type RunRecord,
} from "./run-record.ts"

function sampleRecord(id: string): RunRecord {
  return {
    run_id: id,
    started_at: "2026-10-18T10:00:00Z",
    finished_at: "2026-10-18T10:00:03Z",
    duration_ms: 3000,
    status: "completed",
    variant: "playbook",
    role: { requested: "auto", effective: "engineer" },
    question: "Why did KERNEL errors spike on June 3?",
    scope: { dataset: "bgl" },
    model_id: "claude-opus-5-5",
    effort: "high",
    guidance_version: "1.0.6",
    contract_version: "2.10.0",
    data_version: "dv_test",
    instruction_texts: ["common rules", "engineer summary"],
    phases: [
      {
        kind: "investigate",
        steps: [
          {
            tool: "count_events",
            input: { dataset: "bgl" },
            receipt_id: "r_12345678",
            duration_ms: 12,
            error_kind: null,
          },
        ],
      },
    ],
    coverage_requests: [],
    gate_findings: [[]],
    usage: { input: 1000, output: 200, cache_read: 800, cache_write: 50 },
    final_text: "Scope … Answer … Unknown … Verification …",
    check_claims: [{ receipt_id: "r_abcdef01", summary: { checked: 2 } }],
    error_kind: null,
  }
}

describe("run id", () => {
  it("is run_ plus 8 hex digits", () => {
    expect(newRunId()).toMatch(RUN_ID_PATTERN)
  })
})

describe("RunRecord schema", () => {
  it("accepts a full record and rejects a bad run id", () => {
    expect(() =>
      runRecordSchema.parse(sampleRecord("run_1a2b3c4d"))
    ).not.toThrow()
    expect(() => runRecordSchema.parse(sampleRecord("bad"))).toThrow(
      /must match pattern/
    )
  })

  it("allows nullable usage fields when unknown", () => {
    const record = sampleRecord("run_1a2b3c4d")
    record.usage = {
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
    }
    expect(() => runRecordSchema.parse(record)).not.toThrow()
  })
})

describe("resolveRunsDir", () => {
  it("defaults under the workspace root .data/runs", () => {
    expect(resolveRunsDir({})).toMatch(/\.data\/runs$/)
  })

  it("honours an absolute LOG_INSIGHTS_RUNS_DIR override", () => {
    expect(resolveRunsDir({ LOG_INSIGHTS_RUNS_DIR: "/tmp/runs" })).toBe(
      "/tmp/runs"
    )
  })
})

describe("FileRunStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runs-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("writes <run_id>.json atomically and reads it back", async () => {
    const store = new FileRunStore(dir)
    const record = sampleRecord("run_1a2b3c4d")
    await store.put(record)
    const onDisk = JSON.parse(
      await readFile(join(dir, "run_1a2b3c4d.json"), "utf8")
    )
    expect(onDisk).toEqual(record)
    expect(await store.get("run_1a2b3c4d")).toEqual(record)
  })

  it("returns null for an unknown or malformed id", async () => {
    const store = new FileRunStore(dir)
    expect(await store.get("run_00000000")).toBeNull()
    expect(await store.get("../escape")).toBeNull()
  })

  it("rejects a malformed id before forming a path", async () => {
    const store = new FileRunStore(dir)
    await expect(
      store.put({ ...sampleRecord("run_1a2b3c4d"), run_id: "bad" })
    ).rejects.toThrow(/invalid run id/)
  })
})
